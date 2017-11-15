'use strict';

const each = require('async-each');
const fs = require('fs');
const Handlebars = require('handlebars');
const inflection = require('inflection');
const mkdirp = require('mkdirp');
const sysPath = require('path');
const logger = require('loggy');
const _ = require('lodash');

function clone(object) {
  if (typeof object !== 'object') return object;
  if (Array.isArray(object)) return object.slice().map(clone);
  let cloned = {};

  Object.keys(object).forEach(key => {
    cloned[key] = clone(object[key]);
  });
  return cloned;
}

// Async filter.
function filter(list, predicate, callback) {
  each(list, (item, next) => {
    predicate(item, value => next(undefined, value));
  }, (error, filtered) => {
    if (error) throw new Error(error);
    callback(list.filter((_, index) => filtered[index]));
  });
};

exports.formatTemplate = (template, templateData) => {
  if (!template) return '';
  const key = '__TEMPLATE_FORMATTER';
  const compiled = Handlebars.compile(template.replace(/\\\{/, key));
  return compiled(templateData).toString().replace(key, '\\');
};

function camelize(string) {
  const regexp = /[-_]([a-z])/g;
  const camelized = string.replace(regexp, (match, char) => char.toUpperCase());
  return camelized[0].toLowerCase() + camelized.slice(1);
};

Handlebars.registerHelper('pascalCase', (function() {
  return function(options) {
    const camelString = camelize(options.fn(this));
    return new Handlebars.SafeString(camelString[0].toUpperCase() + camelString.slice(1));
  }
})());

Handlebars.registerHelper('camelCase', (function() {
  return function(options) {
    return new Handlebars.SafeString(camelize(options.fn(this)));
  }
})());

Handlebars.registerHelper('through', (function() {
  return function(options) {
    return new Handlebars.SafeString("{{" + options.hash["value"] + "}}");
  }
})());

exports.loadHelpers = helpersPath => {
  var path = sysPath.resolve(helpersPath);
  var helpers = require(path);
  helpers(Handlebars);
}

exports.generateFile = (path, data, method, callback) => {
  fs.exists(path, exists => {
    if (exists && method !== 'overwrite' && method !== 'append') {
      logger.info("skipping " + path + " (already exists)");
      if (callback != null) return callback();
    } else {
      const parentDir = sysPath.dirname(path);
      function write() {
        if (method === 'create' || method === 'overwrite') {
          logger.info("create " + path);
          fs.writeFile(path, data, callback);
        } else if (method === 'append') {
          logger.info("appending to " + path);
          fs.appendFile(path, data, callback);
        }
      };

      fs.exists(parentDir, exists => {
        if (exists) return write();
        logger.info("init " + parentDir);
        // chmod 755.
        mkdirp(parentDir, 0x1ed, error => {
          if (error != null) return logger.error(error);
          write();
        });
      });
    }
  });
};

exports.destroyFile = (path, callback) => {
  fs.unlink(path, error => {
    if (error != null) {
      callback(error);
      return logger.error("" + error);
    }
    logger.info("destroy " + path);
    callback();
  });
};

exports.amendFile = (path, contents, callback) => {
  fs.readFile(path, 'utf8', (error, existingContents) => {
    fs.writeFile(path, existingContents.replace(contents, ''), error => {
      if (error != null) {
        callback(error);
        return logger.error("" + error);
      }
      logger.info("editing contents of " + path);
      callback();
    });
  });
};

exports.scaffoldFile = (revert, from, base, method, templateData, parentPath, name, callback) => {
  // inject directly
  templateData.pluralName = name ? inflection.pluralize(name) : templateData.pluralName
  templateData.parentPath = parentPath

  if (parentPath === 'migrations') {
    if (!fs.existsSync(parentPath)) {
      fs.mkdirSync(parentPath);
    }

    var files = fs.readdirSync(parentPath);

    files = files.sort((a, b) => {
      return Number(a.slice(0, 6)) < Number(b.slice(0, 6));
    });

    if (files.length === 0) {
      templateData.fileNumber = '000005';
    } else {
      var fileNumber = (Number(files[0].slice(0,6)) + 5).toString();
      templateData.fileNumber = _.padStart(fileNumber, 6, '0');
    }
  }

  const to = exports.formatTemplate(parentPath + '/' + base, templateData);

  if (revert && method !== 'append') {
    exports.destroyFile(to, callback);
  } else {
    fs.readFile(from, 'utf8', (error, contents) => {
      var formatted = (() => {
        try {
          return exports.formatTemplate(contents, templateData);
        } catch (error) {
          console.log(error);
          return contents;
        }
      })();
      if (revert && method === 'append') {
        exports.amendFile(to, formatted, callback);
      } else {
        exports.generateFile(to, formatted, method, callback);
      }
    });
  }
};

exports.scaffoldFiles = (revert, templateData) => {
  return (generator, callback) => {
    if (generator.helpers) exports.loadHelpers(generator.helpers);
    each(generator.files, (args, next) => {
      exports.scaffoldFile(
        revert, args.from, args.base, args.method, templateData,
        args.parentPath, args.name, next
      );
    }, callback);
  };
};

exports.isDirectory = generatorsPath => {
  return (path, callback) => {
    fs.stat(sysPath.join(generatorsPath, path), (error, stats) => {
      if (error != null) logger.error(error);
      callback(stats.isDirectory());
    });
  };
};

exports.readGeneratorConfig = generatorsPath => {
  return (type, callback) => {
    const path = sysPath.resolve(sysPath.join(generatorsPath, type, 'generator.json'));
    const json = require(path);
    json.type = type;

    const helpersPath = sysPath.join(generatorsPath, type, 'helpers.js');
    fs.stat(sysPath.resolve(helpersPath), (error, stats) => {
      if (error == null && stats.isFile()) {
        json.helpers = helpersPath;
      }
      callback(null, json);
    });
  };
};

exports.formatGeneratorConfig = (path, json, templateData) => {
  function join(file) {
    return sysPath.join(path, file);
  };

  if (json.dependencies == null) json.dependencies = [];
  const defaultMethod = 'create';

  json.files = json.files.map(object => {
    return {
      method: object.method || defaultMethod,
      base: sysPath.basename(object.to),
      from: join(object.from),
      parentPath: templateData.parentPath || sysPath.dirname(object.to)
    };
  });

  if (templateData.parentPath)
    json.parentPath = templateData.parentPath;

  json.dependencies = json.dependencies.map(object => {
    if (!object.type) {
      object.type = object.name;
      object.name = undefined;
    }

    const dependencyTemplateData = clone(templateData);
    dependencyTemplateData.parentPath = json.parentPath;

    if (object.parentPath && !json.parentPath) {
      logger.warn('generator "' + json.type + '" needs parentPath to function correctly with dependencies');
    }

    return {
      method: object.method || defaultMethod,
      type: exports.formatTemplate(object.type, dependencyTemplateData),
      name: exports.formatTemplate(object.name || dependencyTemplateData.name, dependencyTemplateData),
      parentPath: exports.formatTemplate(object.parentPath || templateData.parentPath, dependencyTemplateData)
    };
  });

  return Object.freeze(json);
};

exports.getDependencyTree = (generators, type, memo, dep) => {
  if (memo == null) memo = [];
  const generator = clone(generators.filter(gen => gen.type === type)[0]);

  if (generator == null) {
    throw new Error("Invalid generator " + type);
  }

  if (dep && dep.parentPath) {
    generator.files.forEach(file => {
      if (dep.parentPath) file.parentPath = dep.parentPath;
      if (dep.name) file.name = dep.name;
    });
  }

  (generator.dependencies || []).forEach(dependency => {
    exports.getDependencyTree(generators, dependency.type, memo, dependency);
  });

  memo.push(Object.freeze(generator));
  return memo;
};

exports.generateFiles = (revert, generatorsPath, type, templateData, callback) => {
  fs.readdir(generatorsPath, (error, files) => {
    if (error != null) throw new Error(error);

    // Get directories from generators directory.
    filter(files, exports.isDirectory(generatorsPath), directories => {
      // Read all generator configs.
      each(directories, exports.readGeneratorConfig(generatorsPath), (error, configs) => {
        if (error != null) throw new Error(error);

        const generators = directories.map((directory, index) => {
          const path = sysPath.join(generatorsPath, directory);
          return exports.formatGeneratorConfig(path, configs[index], templateData);
        });

        // Calculate dependency trees, do the scaffolding.
        const tree = exports.getDependencyTree(generators, type);
        // console.log(JSON.stringify(tree, null, 2));
        each(tree, exports.scaffoldFiles(revert, templateData), callback);
      });
    });
  });
};

exports.listGenerators = (generatorsPath, callback) => {
  fs.readdir(generatorsPath, (error, files) => {
    if (error != null) throw new Error(error);

    // Get directories from generators directory.
    filter(files, exports.isDirectory(generatorsPath), directories => {
      console.log("List of available generators in ./" + generatorsPath + ":");

      each(directories, exports.readGeneratorConfig(generatorsPath), (error, configs) => {
        configs.map(generator => {
          let doc = " * ";
          doc += (generator.name) ? generator.name : generator.type;
          if (generator.description) doc += " ("+ generator.description + ")";
          console.log(doc);
        });
      });
    });
  });
};

exports.helpGenerator = (generatorsPath, type, templateData) => {
  fs.readdir(generatorsPath, (error, files) => {
    if (error != null) throw new Error(error);

    // Get directories from generators directory.
    filter(files, exports.isDirectory(generatorsPath), directories => {
      // Read all generator configs.
      each(directories, exports.readGeneratorConfig(generatorsPath), (error, configs) => {
        if (error != null) throw new Error(error);

        const generators = directories.map((directory, index) => {
          const path = sysPath.join(generatorsPath, directory);
          return exports.formatGeneratorConfig(path, configs[index], templateData);
        });

        let tree = exports.getDependencyTree(generators, type);
        tree.reverse();

        tree.map((generator, index) => {
          if (index == 0) {
            console.log("Documentation for '" + type + "' generator:");

            if (generator.description) {
              console.log(generator.description+"\n");
            }

            console.log("'scaffolt " + type + " name'");
          } else {
            let doc = " * " + generator.type;

            if (generator.description) {
              doc += " (" + generator.description + ")";
            }

            console.log(doc);
          }

          each(generator.files, args => {
            console.log("\twill " + args.method + " " + args.to);
          });

          if (index == 0 && tree.length > 1) {
            console.log("");
            console.log("Dependencies:");
          }
        });
      });
    });
  });
};

function checkIfExists(generatorsPath, callback) {
  fs.exists(generatorsPath, exists => {
    if (!exists) {
      const msg = 'Generators directory "' + generatorsPath + '" does not exist';
      logger.error(msg);
      return callback(new Error(msg));
    }

    callback();
  });
};

function scaffolt(type, moduleName, name, options, callback) {
  // Set some default params.
  if (options == null) options = {};
  if (callback == null) callback = function() {};
  let pluralName = options.pluralName;
  let generatorsPath = options.generatorsPath;
  let revert = options.revert;
  const parentPath = options.parentPath;
  if (pluralName == null) pluralName = inflection.pluralize(name);
  if (generatorsPath == null) generatorsPath = 'generators';
  if (revert == null) revert = false;
  const templateData = {name: name, moduleName: moduleName, pluralName: pluralName, parentPath: parentPath, type:type};

  for(let key in options){
    switch(key[0]) {
      case '$':
        templateData[key] = options[key];
        break;
      case '@':
        templateData[key.substring(1)] = options[key];
        break;
      default:
        break;
    }
  }

  checkIfExists(generatorsPath, exists => {
    exports.generateFiles(revert, generatorsPath, type, templateData, function(error) {
      if (error != null) {
        logger.error(error);
        return callback(error);
      }

      callback();
    });
  });
};


scaffolt.list = (options, callback) => {
  // Set some default params
  if (options == null) options = {};
  if (callback == null) callback = () => {};
  let generatorsPath = options.generatorsPath;
  if (generatorsPath == null) generatorsPath = 'generators';

  checkIfExists(generatorsPath, () => {
    exports.listGenerators(generatorsPath, error => {
      if (error != null) {
        logger.error(error);
        return callback(error);
      }
      callback();
    });
  });
};

scaffolt.help = (type, options) => {
  // Set some default params
  if (options == null) options = {};
  let generatorsPath = options.generatorsPath;
  if (generatorsPath == null) generatorsPath = 'generators';
  const templateData = {name: "name", pluralName: "names"};

  checkIfExists(generatorsPath, function() {
    exports.helpGenerator(generatorsPath, type, templateData);
  });
};

module.exports = scaffolt;
