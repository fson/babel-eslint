var babylonToEspree = require("./babylon-to-espree");
var Module         = require("module");
var path           = require("path");
var parse          = require("babylon").parse;
var t              = require("babel-types");
var tt             = require("babylon").tokTypes;
var traverse       = require("babel-traverse").default;

var estraverse;
var hasPatched = false;
var eslintOptions = {};

function createModule(filename) {
  var mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  return mod;
}

function monkeypatch() {
  if (hasPatched) return;
  hasPatched = true;

  var eslintLoc;
  try {
    // avoid importing a local copy of eslint, try to find a peer dependency
    eslintLoc = Module._resolveFilename("eslint", module.parent);
  } catch (err) {
    try {
      // avoids breaking in jest where module.parent is undefined
      eslintLoc = require.resolve("eslint");
    } catch (err) {
      throw new ReferenceError("couldn't resolve eslint");
    }
  }

  // get modules relative to what eslint will load
  var eslintMod = createModule(eslintLoc);
  var escopeLoc = Module._resolveFilename("escope", eslintMod);
  var escopeMod = createModule(escopeLoc);

  // npm 3: monkeypatch estraverse if it's in escope
  var estraverseRelative = escopeMod;
  try {
    var esrecurseLoc = Module._resolveFilename("esrecurse", eslintMod);
    estraverseRelative = createModule(esrecurseLoc);
  } catch (err) {}

  // contains all the instances of estraverse so we can modify them if necessary
  var estraverses = [];

  // monkeypatch estraverse
  estraverse = estraverseRelative.require("estraverse");
  estraverses.push(estraverse);

  var estraverseOfEslint = eslintMod.require("estraverse");
  estraverses.push(estraverseOfEslint);
  Object.assign(estraverseOfEslint.VisitorKeys, t.VISITOR_KEYS);

  Object.assign(estraverse.VisitorKeys, t.VISITOR_KEYS);

  estraverses.forEach(function (estraverse) {
    estraverse.VisitorKeys.MethodDefinition.push("decorators");
    estraverse.VisitorKeys.Property.push("decorators");
  });

  // monkeypatch escope
  var escope  = require(escopeLoc);
  var analyze = escope.analyze;
  escope.analyze = function (ast, opts) {
    opts.ecmaVersion = eslintOptions.ecmaVersion;
    opts.sourceType = eslintOptions.sourceType;
    if (eslintOptions.globalReturn !== undefined) {
      opts.nodejsScope = eslintOptions.globalReturn;
    }

    var results = analyze.call(this, ast, opts);
    return results;
  };

  // monkeypatch escope/referencer
  var referencerLoc;
  try {
    referencerLoc = Module._resolveFilename("./referencer", escopeMod);
  } catch (err) {
    throw new ReferenceError("couldn't resolve escope/referencer");
  }
  var referencer = require(referencerLoc);
  if (referencer.__esModule) {
    referencer = referencer.default;
  }

  // if there are decorators, then visit each
  function visitDecorators(node) {
    if (!node.decorators) {
      return;
    }
    for (var i = 0; i < node.decorators.length; i++) {
      if (node.decorators[i].expression) {
        this.visit(node.decorators[i]);
      }
    }
  }

  // visit decorators that are in: ClassDeclaration / ClassExpression
  var visitClass = referencer.prototype.visitClass;
  referencer.prototype.visitClass = function(node) {
    visitDecorators.call(this, node);
    visitClass.call(this, node);
  };

  // visit decorators that are in: Property / MethodDefinition
  var visitProperty = referencer.prototype.visitProperty;
  referencer.prototype.visitProperty = function(node) {
    visitDecorators.call(this, node);
    visitProperty.call(this, node);
  };

  // visit ClassProperty as a Property.
  referencer.prototype.ClassProperty = function(node) {
    this.visitProperty(node);
  };

  var visitFunction = referencer.prototype.visitFunction;
  referencer.prototype.visitFunction = function(node) {
    // set ArrayPattern/ObjectPattern visitor keys back to their original. otherwise
    // escope will traverse into them and include the identifiers within as declarations
    estraverses.forEach(function (estraverse) {
      estraverse.VisitorKeys.ObjectPattern = ["properties"];
      estraverse.VisitorKeys.ArrayPattern = ["elements"];
    });
    visitFunction.call(this, node);
    // set them back to normal...
    estraverses.forEach(function (estraverse) {
      estraverse.VisitorKeys.ObjectPattern = t.VISITOR_KEYS.ObjectPattern;
      estraverse.VisitorKeys.ArrayPattern = t.VISITOR_KEYS.ArrayPattern;
    });
  };
}

exports.parse = function (code, options) {
  options = options || {};
  eslintOptions.ecmaVersion = options.ecmaVersion = options.ecmaVersion || 6;
  eslintOptions.sourceType = options.sourceType = options.sourceType || "module";
  eslintOptions.allowImportExportEverywhere = options.allowImportExportEverywhere = options.allowImportExportEverywhere || false;
  if (options.sourceType === "module") {
    eslintOptions.globalReturn = false;
  } else {
    delete eslintOptions.globalReturn;
  }

  try {
    monkeypatch();
  } catch (err) {
    console.error(err.stack);
    process.exit(1);
  }

  return exports.parseNoPatch(code, options);
};

exports.parseNoPatch = function (code, options) {
  var opts = {
    sourceType: options.sourceType,
    allowImportExportEverywhere: options.allowImportExportEverywhere, // consistent with espree
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    plugins: [
      "flow",
      "jsx",
      "asyncFunctions",
      "asyncGenerators",
      "classConstructorCall",
      "classProperties",
      "decorators",
      "doExpressions",
      "exponentiationOperator",
      "exportExtensions",
      "functionBind",
      "functionSent",
      "objectRestSpread",
      "trailingFunctionCommas"
    ]
  };

  var ast;
  try {
    ast = parse(code, opts);
  } catch (err) {
    if (err instanceof SyntaxError) {
      err.lineNumber = err.loc.line;
      err.column = err.loc.column + 1;

      // remove trailing "(LINE:COLUMN)" acorn message and add in esprima syntax error message start
      err.message = "Line " + err.lineNumber + ": " + err.message.replace(/ \((\d+):(\d+)\)$/, "");
    }

    throw err;
  }

  // remove EOF token, eslint doesn't use this for anything and it interferes with some rules
  // see https://github.com/babel/babel-eslint/issues/2 for more info
  // todo: find a more elegant way to do this
  ast.tokens.pop();

  // convert tokens
  ast.tokens = babylonToEspree.toTokens(ast.tokens, tt, code);

  // add comments
  babylonToEspree.convertComments(ast.comments);

  // transform esprima and acorn divergent nodes
  babylonToEspree.toAST(ast, traverse, code);

  // ast.program.tokens = ast.tokens;
  // ast.program.comments = ast.comments;
  // ast = ast.program;

  // remove File
  ast.type = "Program";
  ast.sourceType = ast.program.sourceType;
  ast.directives = ast.program.directives;
  ast.body = ast.program.body;
  delete ast.program;
  delete ast._paths;

  babylonToEspree.attachComments(ast, ast.comments, ast.tokens);

  return ast;
};
