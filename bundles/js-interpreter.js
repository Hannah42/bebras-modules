// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke and released under an MIT
// license. The Unicode regexps (for identifiers and whitespace) were
// taken from [Esprima](http://esprima.org) by Ariya Hidayat.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js

(function(root, mod) {
  if (typeof exports == "object" && typeof module == "object") return mod(exports); // CommonJS
  if (typeof define == "function" && define.amd) return define(["exports"], mod); // AMD
  mod(root.acorn || (root.acorn = {})); // Plain browser env
})(this, function(exports) {
  "use strict";

  exports.version = "0.4.1";

  // The main exported interface (under `self.acorn` when in the
  // browser) is a `parse` function that takes a code string and
  // returns an abstract syntax tree as specified by [Mozilla parser
  // API][api], with the caveat that the SpiderMonkey-specific syntax
  // (`let`, `yield`, inline XML, etc) is not recognized.
  //
  // [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

  var options, input, inputLen, sourceFile;

  exports.parse = function(inpt, opts) {
    input = String(inpt); inputLen = input.length;
    setOptions(opts);
    initTokenState();
    return parseTopLevel(options.program);
  };

  // A second optional argument can be given to further configure
  // the parser process. These options are recognized:

  var defaultOptions = exports.defaultOptions = {
    // `ecmaVersion` indicates the ECMAScript version to parse. Must
    // be either 3 or 5. This
    // influences support for strict mode, the set of reserved words, and
    // support for getters and setter.
    ecmaVersion: 5,
    // Turn on `strictSemicolons` to prevent the parser from doing
    // automatic semicolon insertion.
    strictSemicolons: false,
    // When `allowTrailingCommas` is false, the parser will not allow
    // trailing commas in array and object literals.
    allowTrailingCommas: true,
    // By default, reserved words are not enforced. Enable
    // `forbidReserved` to enforce them.
    forbidReserved: false,
    // When `locations` is on, `loc` properties holding objects with
    // `start` and `end` properties in `{line, column}` form (with
    // line being 1-based and column 0-based) will be attached to the
    // nodes.
    locations: false,
    // A function can be passed as `onComment` option, which will
    // cause Acorn to call that function with `(block, text, start,
    // end)` parameters whenever a comment is skipped. `block` is a
    // boolean indicating whether this is a block (`/* */`) comment,
    // `text` is the content of the comment, and `start` and `end` are
    // character offsets that denote the start and end of the comment.
    // When the `locations` option is on, two more parameters are
    // passed, the full `{line, column}` locations of the start and
    // end of the comments.
    onComment: null,
    // Nodes have their start and end characters offsets recorded in
    // `start` and `end` properties (directly on the node, rather than
    // the `loc` object, which holds line/column data. To also add a
    // [semi-standardized][range] `range` property holding a `[start,
    // end]` array with the same numbers, set the `ranges` option to
    // `true`.
    //
    // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
    ranges: false,
    // It is possible to parse multiple files into a single AST by
    // passing the tree produced by parsing the first file as
    // `program` option in subsequent parses. This will add the
    // toplevel forms of the parsed file to the `Program` (top) node
    // of an existing parse tree.
    program: null,
    // When `location` is on, you can pass this to record the source
    // file in every node's `loc` object.
    sourceFile: null,
    // This value, if given, is stored in every node, whether
    // `location` is on or off.
    directSourceFile: null
  };

  function setOptions(opts) {
    options = opts || {};
    for (var opt in defaultOptions) if (!Object.prototype.hasOwnProperty.call(options, opt))
      options[opt] = defaultOptions[opt];
    sourceFile = options.sourceFile || null;
  }

  // The `getLineInfo` function is mostly useful when the
  // `locations` option is off (for performance reasons) and you
  // want to find the line/column position for a given character
  // offset. `input` should be the code string that the offset refers
  // into.

  var getLineInfo = exports.getLineInfo = function(input, offset) {
    for (var line = 1, cur = 0;;) {
      lineBreak.lastIndex = cur;
      var match = lineBreak.exec(input);
      if (match && match.index < offset) {
        ++line;
        cur = match.index + match[0].length;
      } else break;
    }
    return {line: line, column: offset - cur};
  };

  // Acorn is organized as a tokenizer and a recursive-descent parser.
  // The `tokenize` export provides an interface to the tokenizer.
  // Because the tokenizer is optimized for being efficiently used by
  // the Acorn parser itself, this interface is somewhat crude and not
  // very modular. Performing another parse or call to `tokenize` will
  // reset the internal state, and invalidate existing tokenizers.

  exports.tokenize = function(inpt, opts) {
    input = String(inpt); inputLen = input.length;
    setOptions(opts);
    initTokenState();

    var t = {};
    function getToken(forceRegexp) {
      readToken(forceRegexp);
      t.start = tokStart; t.end = tokEnd;
      t.startLoc = tokStartLoc; t.endLoc = tokEndLoc;
      t.type = tokType; t.value = tokVal;
      return t;
    }
    getToken.jumpTo = function(pos, reAllowed) {
      tokPos = pos;
      if (options.locations) {
        tokCurLine = 1;
        tokLineStart = lineBreak.lastIndex = 0;
        var match;
        while ((match = lineBreak.exec(input)) && match.index < pos) {
          ++tokCurLine;
          tokLineStart = match.index + match[0].length;
        }
      }
      tokRegexpAllowed = reAllowed;
      skipSpace();
    };
    return getToken;
  };

  // State is kept in (closure-)global variables. We already saw the
  // `options`, `input`, and `inputLen` variables above.

  // The current position of the tokenizer in the input.

  var tokPos;

  // The start and end offsets of the current token.

  var tokStart, tokEnd;

  // When `options.locations` is true, these hold objects
  // containing the tokens start and end line/column pairs.

  var tokStartLoc, tokEndLoc;

  // The type and value of the current token. Token types are objects,
  // named by variables against which they can be compared, and
  // holding properties that describe them (indicating, for example,
  // the precedence of an infix operator, and the original name of a
  // keyword token). The kind of value that's held in `tokVal` depends
  // on the type of the token. For literals, it is the literal value,
  // for operators, the operator name, and so on.

  var tokType, tokVal;

  // Interal state for the tokenizer. To distinguish between division
  // operators and regular expressions, it remembers whether the last
  // token was one that is allowed to be followed by an expression.
  // (If it is, a slash is probably a regexp, if it isn't it's a
  // division operator. See the `parseStatement` function for a
  // caveat.)

  var tokRegexpAllowed;

  // When `options.locations` is true, these are used to keep
  // track of the current line, and know when a new line has been
  // entered.

  var tokCurLine, tokLineStart;

  // These store the position of the previous token, which is useful
  // when finishing a node and assigning its `end` position.

  var lastStart, lastEnd, lastEndLoc;

  // This is the parser's state. `inFunction` is used to reject
  // `return` statements outside of functions, `labels` to verify that
  // `break` and `continue` have somewhere to jump to, and `strict`
  // indicates whether strict mode is on.

  var inFunction, labels, strict;

  // This function is used to raise exceptions on parse errors. It
  // takes an offset integer (into the current `input`) to indicate
  // the location of the error, attaches the position to the end
  // of the error message, and then raises a `SyntaxError` with that
  // message.

  function raise(pos, message) {
    var loc = getLineInfo(input, pos);
    message += " (" + loc.line + ":" + loc.column + ")";
    var err = new SyntaxError(message);
    err.pos = pos; err.loc = loc; err.raisedAt = tokPos;
    throw err;
  }

  // Reused empty array added for node fields that are always empty.

  var empty = [];

  // ## Token types

  // The assignment of fine-grained, information-carrying type objects
  // allows the tokenizer to store the information it has about a
  // token in a way that is very cheap for the parser to look up.

  // All token type variables start with an underscore, to make them
  // easy to recognize.

  // These are the general types. The `type` property is only used to
  // make them recognizeable when debugging.

  var _num = {type: "num"}, _regexp = {type: "regexp"}, _string = {type: "string"};
  var _name = {type: "name"}, _eof = {type: "eof"};

  // Keyword tokens. The `keyword` property (also used in keyword-like
  // operators) indicates that the token originated from an
  // identifier-like word, which is used when parsing property names.
  //
  // The `beforeExpr` property is used to disambiguate between regular
  // expressions and divisions. It is set on all token types that can
  // be followed by an expression (thus, a slash after them would be a
  // regular expression).
  //
  // `isLoop` marks a keyword as starting a loop, which is important
  // to know when parsing a label, in order to allow or disallow
  // continue jumps to that label.

  var _break = {keyword: "break"}, _case = {keyword: "case", beforeExpr: true}, _catch = {keyword: "catch"};
  var _continue = {keyword: "continue"}, _debugger = {keyword: "debugger"}, _default = {keyword: "default"};
  var _do = {keyword: "do", isLoop: true}, _else = {keyword: "else", beforeExpr: true};
  var _finally = {keyword: "finally"}, _for = {keyword: "for", isLoop: true}, _function = {keyword: "function"};
  var _if = {keyword: "if"}, _return = {keyword: "return", beforeExpr: true}, _switch = {keyword: "switch"};
  var _throw = {keyword: "throw", beforeExpr: true}, _try = {keyword: "try"}, _var = {keyword: "var"};
  var _while = {keyword: "while", isLoop: true}, _with = {keyword: "with"}, _new = {keyword: "new", beforeExpr: true};
  var _this = {keyword: "this"};

  // The keywords that denote values.

  var _null = {keyword: "null", atomValue: null}, _true = {keyword: "true", atomValue: true};
  var _false = {keyword: "false", atomValue: false};

  // Some keywords are treated as regular operators. `in` sometimes
  // (when parsing `for`) needs to be tested against specifically, so
  // we assign a variable name to it for quick comparing.

  var _in = {keyword: "in", binop: 7, beforeExpr: true};

  // Map keyword names to token types.

  var keywordTypes = {"break": _break, "case": _case, "catch": _catch,
                      "continue": _continue, "debugger": _debugger, "default": _default,
                      "do": _do, "else": _else, "finally": _finally, "for": _for,
                      "function": _function, "if": _if, "return": _return, "switch": _switch,
                      "throw": _throw, "try": _try, "var": _var, "while": _while, "with": _with,
                      "null": _null, "true": _true, "false": _false, "new": _new, "in": _in,
                      "instanceof": {keyword: "instanceof", binop: 7, beforeExpr: true}, "this": _this,
                      "typeof": {keyword: "typeof", prefix: true, beforeExpr: true},
                      "void": {keyword: "void", prefix: true, beforeExpr: true},
                      "delete": {keyword: "delete", prefix: true, beforeExpr: true}};

  // Punctuation token types. Again, the `type` property is purely for debugging.

  var _bracketL = {type: "[", beforeExpr: true}, _bracketR = {type: "]"}, _braceL = {type: "{", beforeExpr: true};
  var _braceR = {type: "}"}, _parenL = {type: "(", beforeExpr: true}, _parenR = {type: ")"};
  var _comma = {type: ",", beforeExpr: true}, _semi = {type: ";", beforeExpr: true};
  var _colon = {type: ":", beforeExpr: true}, _dot = {type: "."}, _question = {type: "?", beforeExpr: true};

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator. `isUpdate` specifies that the node produced by
  // the operator should be of type UpdateExpression rather than
  // simply UnaryExpression (`++` and `--`).
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  var _slash = {binop: 10, beforeExpr: true}, _eq = {isAssign: true, beforeExpr: true};
  var _assign = {isAssign: true, beforeExpr: true};
  var _incDec = {postfix: true, prefix: true, isUpdate: true}, _prefix = {prefix: true, beforeExpr: true};
  var _logicalOR = {binop: 1, beforeExpr: true};
  var _logicalAND = {binop: 2, beforeExpr: true};
  var _bitwiseOR = {binop: 3, beforeExpr: true};
  var _bitwiseXOR = {binop: 4, beforeExpr: true};
  var _bitwiseAND = {binop: 5, beforeExpr: true};
  var _equality = {binop: 6, beforeExpr: true};
  var _relational = {binop: 7, beforeExpr: true};
  var _bitShift = {binop: 8, beforeExpr: true};
  var _plusMin = {binop: 9, prefix: true, beforeExpr: true};
  var _multiplyModulo = {binop: 10, beforeExpr: true};

  // Provide access to the token types for external users of the
  // tokenizer.

  exports.tokTypes = {bracketL: _bracketL, bracketR: _bracketR, braceL: _braceL, braceR: _braceR,
                      parenL: _parenL, parenR: _parenR, comma: _comma, semi: _semi, colon: _colon,
                      dot: _dot, question: _question, slash: _slash, eq: _eq, name: _name, eof: _eof,
                      num: _num, regexp: _regexp, string: _string};
  for (var kw in keywordTypes) exports.tokTypes["_" + kw] = keywordTypes[kw];

  // This is a trick taken from Esprima. It turns out that, on
  // non-Chrome browsers, to check whether a string is in a set, a
  // predicate containing a big ugly `switch` statement is faster than
  // a regular expression, and on Chrome the two are about on par.
  // This function uses `eval` (non-lexical) to produce such a
  // predicate from a space-separated string of words.
  //
  // It starts by sorting the words by length.

  function makePredicate(words) {
    words = words.split(" ");
    var f = "", cats = [];
    out: for (var i = 0; i < words.length; ++i) {
      for (var j = 0; j < cats.length; ++j)
        if (cats[j][0].length == words[i].length) {
          cats[j].push(words[i]);
          continue out;
        }
      cats.push([words[i]]);
    }
    function compareTo(arr) {
      if (arr.length == 1) return f += "return str === " + JSON.stringify(arr[0]) + ";";
      f += "switch(str){";
      for (var i = 0; i < arr.length; ++i) f += "case " + JSON.stringify(arr[i]) + ":";
      f += "return true}return false;";
    }

    // When there are more than three length categories, an outer
    // switch first dispatches on the lengths, to save on comparisons.

    if (cats.length > 3) {
      cats.sort(function(a, b) {return b.length - a.length;});
      f += "switch(str.length){";
      for (var i = 0; i < cats.length; ++i) {
        var cat = cats[i];
        f += "case " + cat[0].length + ":";
        compareTo(cat);
      }
      f += "}";

    // Otherwise, simply generate a flat `switch` statement.

    } else {
      compareTo(words);
    }
    return new Function("str", f);
  }

  // The ECMAScript 3 reserved word list.

  var isReservedWord3 = makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile");

  // ECMAScript 5 reserved words.

  var isReservedWord5 = makePredicate("class enum extends super const export import");

  // The additional reserved words in strict mode.

  var isStrictReservedWord = makePredicate("implements interface let package private protected public static yield");

  // The forbidden variable names in strict mode.

  var isStrictBadIdWord = makePredicate("eval arguments");

  // And the keywords.

  var isKeyword = makePredicate("break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this");

  // ## Character categories

  // Big ugly regular expressions that match characters in the
  // whitespace, identifier, and identifier-start categories. These
  // are only applied when a character is found to actually have a
  // code point above 128.

  var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
  var nonASCIIidentifierStartChars = "\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0\u08a2-\u08ac\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097f\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58\u0c59\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d60\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191c\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19c1-\u19c7\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua697\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa80-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc";
  var nonASCIIidentifierChars = "\u0300-\u036f\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u0620-\u0649\u0672-\u06d3\u06e7-\u06e8\u06fb-\u06fc\u0730-\u074a\u0800-\u0814\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0840-\u0857\u08e4-\u08fe\u0900-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962-\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09d7\u09df-\u09e0\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5f-\u0b60\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2-\u0ce3\u0ce6-\u0cef\u0d02\u0d03\u0d46-\u0d48\u0d57\u0d62-\u0d63\u0d66-\u0d6f\u0d82\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e34-\u0e3a\u0e40-\u0e45\u0e50-\u0e59\u0eb4-\u0eb9\u0ec8-\u0ecd\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f41-\u0f47\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1029\u1040-\u1049\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u170e-\u1710\u1720-\u1730\u1740-\u1750\u1772\u1773\u1780-\u17b2\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1920-\u192b\u1930-\u193b\u1951-\u196d\u19b0-\u19c0\u19c8-\u19c9\u19d0-\u19d9\u1a00-\u1a15\u1a20-\u1a53\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1b46-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1bb0-\u1bb9\u1be6-\u1bf3\u1c00-\u1c22\u1c40-\u1c49\u1c5b-\u1c7d\u1cd0-\u1cd2\u1d00-\u1dbe\u1e01-\u1f15\u200c\u200d\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2d81-\u2d96\u2de0-\u2dff\u3021-\u3028\u3099\u309a\ua640-\ua66d\ua674-\ua67d\ua69f\ua6f0-\ua6f1\ua7f8-\ua800\ua806\ua80b\ua823-\ua827\ua880-\ua881\ua8b4-\ua8c4\ua8d0-\ua8d9\ua8f3-\ua8f7\ua900-\ua909\ua926-\ua92d\ua930-\ua945\ua980-\ua983\ua9b3-\ua9c0\uaa00-\uaa27\uaa40-\uaa41\uaa4c-\uaa4d\uaa50-\uaa59\uaa7b\uaae0-\uaae9\uaaf2-\uaaf3\uabc0-\uabe1\uabec\uabed\uabf0-\uabf9\ufb20-\ufb28\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f";
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

  // Whether a single character denotes a newline.

  var newline = /[\n\r\u2028\u2029]/;

  // Matches a whole line break (where CRLF is considered a single
  // line break). Used to count lines.

  var lineBreak = /\r\n|[\n\r\u2028\u2029]/g;

  // Test whether a given character code starts an identifier.

  var isIdentifierStart = exports.isIdentifierStart = function(code) {
    if (code < 65) return code === 36;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
  };

  // Test whether a given character is part of an identifier.

  var isIdentifierChar = exports.isIdentifierChar = function(code) {
    if (code < 48) return code === 36;
    if (code < 58) return true;
    if (code < 65) return false;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
  };

  // ## Tokenizer

  // These are used when `options.locations` is on, for the
  // `tokStartLoc` and `tokEndLoc` properties.

  function line_loc_t() {
    this.line = tokCurLine;
    this.column = tokPos - tokLineStart;
  }

  // Reset the token state. Used at the start of a parse.

  function initTokenState() {
    tokCurLine = 1;
    tokPos = tokLineStart = 0;
    tokRegexpAllowed = true;
    skipSpace();
  }

  // Called at the end of every token. Sets `tokEnd`, `tokVal`, and
  // `tokRegexpAllowed`, and skips the space after the token, so that
  // the next one's `tokStart` will point at the right position.

  function finishToken(type, val) {
    tokEnd = tokPos;
    if (options.locations) tokEndLoc = new line_loc_t;
    tokType = type;
    skipSpace();
    tokVal = val;
    tokRegexpAllowed = type.beforeExpr;
  }

  function skipBlockComment() {
    var startLoc = options.onComment && options.locations && new line_loc_t;
    var start = tokPos, end = input.indexOf("*/", tokPos += 2);
    if (end === -1) raise(tokPos - 2, "Unterminated comment");
    tokPos = end + 2;
    if (options.locations) {
      lineBreak.lastIndex = start;
      var match;
      while ((match = lineBreak.exec(input)) && match.index < tokPos) {
        ++tokCurLine;
        tokLineStart = match.index + match[0].length;
      }
    }
    if (options.onComment)
      options.onComment(true, input.slice(start + 2, end), start, tokPos,
                        startLoc, options.locations && new line_loc_t);
  }

  function skipLineComment() {
    var start = tokPos;
    var startLoc = options.onComment && options.locations && new line_loc_t;
    var ch = input.charCodeAt(tokPos+=2);
    while (tokPos < inputLen && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
      ++tokPos;
      ch = input.charCodeAt(tokPos);
    }
    if (options.onComment)
      options.onComment(false, input.slice(start + 2, tokPos), start, tokPos,
                        startLoc, options.locations && new line_loc_t);
  }

  // Called at the start of the parse and after every token. Skips
  // whitespace and comments, and.

  function skipSpace() {
    while (tokPos < inputLen) {
      var ch = input.charCodeAt(tokPos);
      if (ch === 32) { // ' '
        ++tokPos;
      } else if (ch === 13) {
        ++tokPos;
        var next = input.charCodeAt(tokPos);
        if (next === 10) {
          ++tokPos;
        }
        if (options.locations) {
          ++tokCurLine;
          tokLineStart = tokPos;
        }
      } else if (ch === 10 || ch === 8232 || ch === 8233) {
        ++tokPos;
        if (options.locations) {
          ++tokCurLine;
          tokLineStart = tokPos;
        }
      } else if (ch > 8 && ch < 14) {
        ++tokPos;
      } else if (ch === 47) { // '/'
        var next = input.charCodeAt(tokPos + 1);
        if (next === 42) { // '*'
          skipBlockComment();
        } else if (next === 47) { // '/'
          skipLineComment();
        } else break;
      } else if (ch === 160) { // '\xa0'
        ++tokPos;
      } else if (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++tokPos;
      } else {
        break;
      }
    }
  }

  // ### Token reading

  // This is the function that is called to fetch the next token. It
  // is somewhat obscure, because it works in character codes rather
  // than characters, and because operator parsing has been inlined
  // into it.
  //
  // All in the name of speed.
  //
  // The `forceRegexp` parameter is used in the one case where the
  // `tokRegexpAllowed` trick does not work. See `parseStatement`.

  function readToken_dot() {
    var next = input.charCodeAt(tokPos + 1);
    if (next >= 48 && next <= 57) return readNumber(true);
    ++tokPos;
    return finishToken(_dot);
  }

  function readToken_slash() { // '/'
    var next = input.charCodeAt(tokPos + 1);
    if (tokRegexpAllowed) {++tokPos; return readRegexp();}
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_slash, 1);
  }

  function readToken_mult_modulo() { // '%*'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_multiplyModulo, 1);
  }

  function readToken_pipe_amp(code) { // '|&'
    var next = input.charCodeAt(tokPos + 1);
    if (next === code) return finishOp(code === 124 ? _logicalOR : _logicalAND, 2);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(code === 124 ? _bitwiseOR : _bitwiseAND, 1);
  }

  function readToken_caret() { // '^'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_bitwiseXOR, 1);
  }

  function readToken_plus_min(code) { // '+-'
    var next = input.charCodeAt(tokPos + 1);
    if (next === code) {
      if (next == 45 && input.charCodeAt(tokPos + 2) == 62 &&
          newline.test(input.slice(lastEnd, tokPos))) {
        // A `-->` line comment
        tokPos += 3;
        skipLineComment();
        skipSpace();
        return readToken();
      }
      return finishOp(_incDec, 2);
    }
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_plusMin, 1);
  }

  function readToken_lt_gt(code) { // '<>'
    var next = input.charCodeAt(tokPos + 1);
    var size = 1;
    if (next === code) {
      size = code === 62 && input.charCodeAt(tokPos + 2) === 62 ? 3 : 2;
      if (input.charCodeAt(tokPos + size) === 61) return finishOp(_assign, size + 1);
      return finishOp(_bitShift, size);
    }
    if (next == 33 && code == 60 && input.charCodeAt(tokPos + 2) == 45 &&
        input.charCodeAt(tokPos + 3) == 45) {
      // `<!--`, an XML-style comment that should be interpreted as a line comment
      tokPos += 4;
      skipLineComment();
      skipSpace();
      return readToken();
    }
    if (next === 61)
      size = input.charCodeAt(tokPos + 2) === 61 ? 3 : 2;
    return finishOp(_relational, size);
  }

  function readToken_eq_excl(code) { // '=!'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_equality, input.charCodeAt(tokPos + 2) === 61 ? 3 : 2);
    return finishOp(code === 61 ? _eq : _prefix, 1);
  }

  function getTokenFromCode(code) {
    switch(code) {
      // The interpretation of a dot depends on whether it is followed
      // by a digit.
    case 46: // '.'
      return readToken_dot();

      // Punctuation tokens.
    case 40: ++tokPos; return finishToken(_parenL);
    case 41: ++tokPos; return finishToken(_parenR);
    case 59: ++tokPos; return finishToken(_semi);
    case 44: ++tokPos; return finishToken(_comma);
    case 91: ++tokPos; return finishToken(_bracketL);
    case 93: ++tokPos; return finishToken(_bracketR);
    case 123: ++tokPos; return finishToken(_braceL);
    case 125: ++tokPos; return finishToken(_braceR);
    case 58: ++tokPos; return finishToken(_colon);
    case 63: ++tokPos; return finishToken(_question);

      // '0x' is a hexadecimal number.
    case 48: // '0'
      var next = input.charCodeAt(tokPos + 1);
      if (next === 120 || next === 88) return readHexNumber();
      // Anything else beginning with a digit is an integer, octal
      // number, or float.
    case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
      return readNumber(false);

      // Quotes produce strings.
    case 34: case 39: // '"', "'"
      return readString(code);

    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.

    case 47: // '/'
      return readToken_slash(code);

    case 37: case 42: // '%*'
      return readToken_mult_modulo();

    case 124: case 38: // '|&'
      return readToken_pipe_amp(code);

    case 94: // '^'
      return readToken_caret();

    case 43: case 45: // '+-'
      return readToken_plus_min(code);

    case 60: case 62: // '<>'
      return readToken_lt_gt(code);

    case 61: case 33: // '=!'
      return readToken_eq_excl(code);

    case 126: // '~'
      return finishOp(_prefix, 1);
    }

    return false;
  }

  function readToken(forceRegexp) {
    if (!forceRegexp) tokStart = tokPos;
    else tokPos = tokStart + 1;
    if (options.locations) tokStartLoc = new line_loc_t;
    if (forceRegexp) return readRegexp();
    if (tokPos >= inputLen) return finishToken(_eof);

    var code = input.charCodeAt(tokPos);
    // Identifier or keyword. '\uXXXX' sequences are allowed in
    // identifiers, so '\' also dispatches to that.
    if (isIdentifierStart(code) || code === 92 /* '\' */) return readWord();

    var tok = getTokenFromCode(code);

    if (tok === false) {
      // If we are here, we either found a non-ASCII identifier
      // character, or something that's entirely disallowed.
      var ch = String.fromCharCode(code);
      if (ch === "\\" || nonASCIIidentifierStart.test(ch)) return readWord();
      raise(tokPos, "Unerwartetes Zeichen '" + ch + "'");
    }
    return tok;
  }

  function finishOp(type, size) {
    var str = input.slice(tokPos, tokPos + size);
    tokPos += size;
    finishToken(type, str);
  }

  // Parse a regular expression. Some context-awareness is necessary,
  // since a '/' inside a '[]' set does not end the expression.

  function readRegexp() {
    var content = "", escaped, inClass, start = tokPos;
    for (;;) {
      if (tokPos >= inputLen) raise(start, "Unterminated regular expression");
      var ch = input.charAt(tokPos);
      if (newline.test(ch)) raise(start, "Unterminated regular expression");
      if (!escaped) {
        if (ch === "[") inClass = true;
        else if (ch === "]" && inClass) inClass = false;
        else if (ch === "/" && !inClass) break;
        escaped = ch === "\\";
      } else escaped = false;
      ++tokPos;
    }
    var content = input.slice(start, tokPos);
    ++tokPos;
    // Need to use `readWord1` because '\uXXXX' sequences are allowed
    // here (don't ask).
    var mods = readWord1();
    if (mods && !/^[gmsiy]*$/.test(mods)) raise(start, "Invalid regexp flag");
    return finishToken(_regexp, new RegExp(content, mods));
  }

  // Read an integer in the given radix. Return null if zero digits
  // were read, the integer value otherwise. When `len` is given, this
  // will return `null` unless the integer has exactly `len` digits.

  function readInt(radix, len) {
    var start = tokPos, total = 0;
    for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
      var code = input.charCodeAt(tokPos), val;
      if (code >= 97) val = code - 97 + 10; // a
      else if (code >= 65) val = code - 65 + 10; // A
      else if (code >= 48 && code <= 57) val = code - 48; // 0-9
      else val = Infinity;
      if (val >= radix) break;
      ++tokPos;
      total = total * radix + val;
    }
    if (tokPos === start || len != null && tokPos - start !== len) return null;

    return total;
  }

  function readHexNumber() {
    tokPos += 2; // 0x
    var val = readInt(16);
    if (val == null) raise(tokStart + 2, "Expected hexadecimal number");
    if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");
    return finishToken(_num, val);
  }

  // Read an integer, octal integer, or floating-point number.

  function readNumber(startsWithDot) {
    var start = tokPos, isFloat = false, octal = input.charCodeAt(tokPos) === 48;
    if (!startsWithDot && readInt(10) === null) raise(start, "Ungültige Zahl");
    if (input.charCodeAt(tokPos) === 46) {
      ++tokPos;
      readInt(10);
      isFloat = true;
    }
    var next = input.charCodeAt(tokPos);
    if (next === 69 || next === 101) { // 'eE'
      next = input.charCodeAt(++tokPos);
      if (next === 43 || next === 45) ++tokPos; // '+-'
      if (readInt(10) === null) raise(start, "Ungültige Zahl");
      isFloat = true;
    }
    if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");

    var str = input.slice(start, tokPos), val;
    if (isFloat) val = parseFloat(str);
    else if (!octal || str.length === 1) val = parseInt(str, 10);
    else if (/[89]/.test(str) || strict) raise(start, "Ungültige Zahl");
    else val = parseInt(str, 8);
    return finishToken(_num, val);
  }

  // Read a string value, interpreting backslash-escapes.

  function readString(quote) {
    tokPos++;
    var out = "";
    for (;;) {
      if (tokPos >= inputLen) raise(tokStart, "Unterminated string constant");
      var ch = input.charCodeAt(tokPos);
      if (ch === quote) {
        ++tokPos;
        return finishToken(_string, out);
      }
      if (ch === 92) { // '\'
        ch = input.charCodeAt(++tokPos);
        var octal = /^[0-7]+/.exec(input.slice(tokPos, tokPos + 3));
        if (octal) octal = octal[0];
        while (octal && parseInt(octal, 8) > 255) octal = octal.slice(0, -1);
        if (octal === "0") octal = null;
        ++tokPos;
        if (octal) {
          if (strict) raise(tokPos - 2, "Octal literal in strict mode");
          out += String.fromCharCode(parseInt(octal, 8));
          tokPos += octal.length - 1;
        } else {
          switch (ch) {
          case 110: out += "\n"; break; // 'n' -> '\n'
          case 114: out += "\r"; break; // 'r' -> '\r'
          case 120: out += String.fromCharCode(readHexChar(2)); break; // 'x'
          case 117: out += String.fromCharCode(readHexChar(4)); break; // 'u'
          case 85: out += String.fromCharCode(readHexChar(8)); break; // 'U'
          case 116: out += "\t"; break; // 't' -> '\t'
          case 98: out += "\b"; break; // 'b' -> '\b'
          case 118: out += "\u000b"; break; // 'v' -> '\u000b'
          case 102: out += "\f"; break; // 'f' -> '\f'
          case 48: out += "\0"; break; // 0 -> '\0'
          case 13: if (input.charCodeAt(tokPos) === 10) ++tokPos; // '\r\n'
          case 10: // ' \n'
            if (options.locations) { tokLineStart = tokPos; ++tokCurLine; }
            break;
          default: out += String.fromCharCode(ch); break;
          }
        }
      } else {
        if (ch === 13 || ch === 10 || ch === 8232 || ch === 8233) raise(tokStart, "Unterminated string constant");
        out += String.fromCharCode(ch); // '\'
        ++tokPos;
      }
    }
  }

  // Used to read character escape sequences ('\x', '\u', '\U').

  function readHexChar(len) {
    var n = readInt(16, len);
    if (n === null) raise(tokStart, "Bad character escape sequence");
    return n;
  }

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.

  var containsEsc;

  // Read an identifier, and return it as a string. Sets `containsEsc`
  // to whether the word contained a '\u' escape.
  //
  // Only builds up the word character-by-character when it actually
  // containeds an escape, as a micro-optimization.

  function readWord1() {
    containsEsc = false;
    var word, first = true, start = tokPos;
    for (;;) {
      var ch = input.charCodeAt(tokPos);
      if (isIdentifierChar(ch)) {
        if (containsEsc) word += input.charAt(tokPos);
        ++tokPos;
      } else if (ch === 92) { // "\"
        if (!containsEsc) word = input.slice(start, tokPos);
        containsEsc = true;
        if (input.charCodeAt(++tokPos) != 117) // "u"
          raise(tokPos, "Expecting Unicode escape sequence \\uXXXX");
        ++tokPos;
        var esc = readHexChar(4);
        var escStr = String.fromCharCode(esc);
        if (!escStr) raise(tokPos - 1, "Invalid Unicode escape");
        if (!(first ? isIdentifierStart(esc) : isIdentifierChar(esc)))
          raise(tokPos - 4, "Invalid Unicode escape");
        word += escStr;
      } else {
        break;
      }
      first = false;
    }
    return containsEsc ? word : input.slice(start, tokPos);
  }

  // Read an identifier or keyword token. Will check for reserved
  // words when necessary.

  function readWord() {
    var word = readWord1();
    var type = _name;
    if (!containsEsc) {
      if (isKeyword(word)) type = keywordTypes[word];
      else if (options.forbidReserved &&
               (options.ecmaVersion === 3 ? isReservedWord3 : isReservedWord5)(word) ||
               strict && isStrictReservedWord(word))
        raise(tokStart, "Die Zeichenkette '" + word + "' ist geschützt");
    }
    return finishToken(type, word);
  }

  // ## Parser

  // A recursive descent parser operates by defining functions for all
  // syntactic elements, and recursively calling those, each function
  // advancing the input stream and returning an AST node. Precedence
  // of constructs (for example, the fact that `!x[1]` means `!(x[1])`
  // instead of `(!x)[1]` is handled by the fact that the parser
  // function that parses unary prefix operators is called first, and
  // in turn calls the function that parses `[]` subscripts — that
  // way, it'll receive the node for `x[1]` already parsed, and wraps
  // *that* in the unary operator node.
  //
  // Acorn uses an [operator precedence parser][opp] to handle binary
  // operator precedence, because it is much more compact than using
  // the technique outlined above, which uses different, nesting
  // functions to specify precedence, for all of the ten binary
  // precedence levels that JavaScript defines.
  //
  // [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

  // ### Parser utilities

  // Continue to the next token.

  function next() {
    lastStart = tokStart;
    lastEnd = tokEnd;
    lastEndLoc = tokEndLoc;
    readToken();
  }

  // Enter strict mode. Re-reads the next token to please pedantic
  // tests ("use strict"; 010; -- should fail).

  function setStrict(strct) {
    strict = strct;
    tokPos = lastEnd;
    if (options.locations) {
      while (tokPos < tokLineStart) {
        tokLineStart = input.lastIndexOf("\n", tokLineStart - 2) + 1;
        --tokCurLine;
      }
    }
    skipSpace();
    readToken();
  }

  // Start an AST node, attaching a start offset.

  function node_t() {
    this.type = null;
    this.start = tokStart;
    this.end = null;
  }

  function node_loc_t() {
    this.start = tokStartLoc;
    this.end = null;
    if (sourceFile !== null) this.source = sourceFile;
  }

  function startNode() {
    var node = new node_t();
    if (options.locations)
      node.loc = new node_loc_t();
    if (options.directSourceFile)
      node.sourceFile = options.directSourceFile;
    if (options.ranges)
      node.range = [tokStart, 0];
    return node;
  }

  // Start a node whose start offset information should be based on
  // the start of another node. For example, a binary operator node is
  // only started after its left-hand side has already been parsed.

  function startNodeFrom(other) {
    var node = new node_t();
    node.start = other.start;
    if (options.locations) {
      node.loc = new node_loc_t();
      node.loc.start = other.loc.start;
    }
    if (options.ranges)
      node.range = [other.range[0], 0];

    return node;
  }

  // Finish an AST node, adding `type` and `end` properties.

  function finishNode(node, type) {
    node.type = type;
    node.end = lastEnd;
    if (options.locations)
      node.loc.end = lastEndLoc;
    if (options.ranges)
      node.range[1] = lastEnd;
    return node;
  }

  // Test whether a statement node is the string literal `"use strict"`.

  function isUseStrict(stmt) {
    return options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "Literal" && stmt.expression.value === "use strict";
  }

  // Predicate that tests whether the next token is of the given
  // type, and if yes, consumes it as a side effect.

  function eat(type) {
    if (tokType === type) {
      next();
      return true;
    }
  }

  // Test whether a semicolon can be inserted at the current position.

  function canInsertSemicolon() {
    return !options.strictSemicolons &&
      (tokType === _eof || tokType === _braceR || newline.test(input.slice(lastEnd, tokStart)));
  }

  // Consume a semicolon, or, failing that, see if we are allowed to
  // pretend that there is a semicolon at this position.

  function semicolon() {
    if (!eat(_semi) && !canInsertSemicolon()) unexpected();
  }

  // Expect a token of a given type. If found, consume it, otherwise,
  // raise an unexpected token error.

  function expect(type) {
    if (tokType === type) next();
    else unexpected();
  }

  // Raise an unexpected token error.

  function unexpected() {
    raise(tokStart, "Unexpected token");
  }

  // Verify that a node is an lval — something that can be assigned
  // to.

  function checkLVal(expr) {
    if (expr.type !== "Identifier" && expr.type !== "MemberExpression")
      raise(expr.start, "Assigning to rvalue");
    if (strict && expr.type === "Identifier" && isStrictBadIdWord(expr.name))
      raise(expr.start, "Assigning to " + expr.name + " in strict mode");
  }

  // ### Statement parsing

  // Parse a program. Initializes the parser, reads any number of
  // statements, and wraps them in a Program node.  Optionally takes a
  // `program` argument.  If present, the statements will be appended
  // to its body instead of creating a new node.

  function parseTopLevel(program) {
    lastStart = lastEnd = tokPos;
    if (options.locations) lastEndLoc = new line_loc_t;
    inFunction = strict = null;
    labels = [];
    readToken();

    var node = program || startNode(), first = true;
    if (!program) node.body = [];
    while (tokType !== _eof) {
      var stmt = parseStatement();
      node.body.push(stmt);
      if (first && isUseStrict(stmt)) setStrict(true);
      first = false;
    }
    return finishNode(node, "Program");
  }

  var loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"};

  // Parse a single statement.
  //
  // If expecting a statement and finding a slash operator, parse a
  // regular expression literal. This is to handle cases like
  // `if (foo) /blah/.exec(foo);`, where looking at the previous token
  // does not help.

  function parseStatement() {
    if (tokType === _slash || tokType === _assign && tokVal == "/=")
      readToken(true);

    var starttype = tokType, node = startNode();

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (starttype) {
    case _break: case _continue:
      next();
      var isBreak = starttype === _break;
      if (eat(_semi) || canInsertSemicolon()) node.label = null;
      else if (tokType !== _name) unexpected();
      else {
        node.label = parseIdent();
        semicolon();
      }

      // Verify that there is an actual destination to break or
      // continue to.
      for (var i = 0; i < labels.length; ++i) {
        var lab = labels[i];
        if (node.label == null || lab.name === node.label.name) {
          if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
          if (node.label && isBreak) break;
        }
      }
      if (i === labels.length) raise(node.start, "Unsyntactic " + starttype.keyword);
      return finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");

    case _debugger:
      next();
      semicolon();
      return finishNode(node, "DebuggerStatement");

    case _do:
      next();
      labels.push(loopLabel);
      node.body = parseStatement();
      labels.pop();
      expect(_while);
      node.test = parseParenExpression();
      semicolon();
      return finishNode(node, "DoWhileStatement");

      // Disambiguating between a `for` and a `for`/`in` loop is
      // non-trivial. Basically, we have to parse the init `var`
      // statement or expression, disallowing the `in` operator (see
      // the second parameter to `parseExpression`), and then check
      // whether the next token is `in`. When there is no init part
      // (semicolon immediately after the opening parenthesis), it is
      // a regular `for` loop.

    case _for:
      next();
      labels.push(loopLabel);
      expect(_parenL);
      if (tokType === _semi) return parseFor(node, null);
      if (tokType === _var) {
        var init = startNode();
        next();
        parseVar(init, true);
        finishNode(init, "VariableDeclaration");
        if (init.declarations.length === 1 && eat(_in))
          return parseForIn(node, init);
        return parseFor(node, init);
      }
      var init = parseExpression(false, true);
      if (eat(_in)) {checkLVal(init); return parseForIn(node, init);}
      return parseFor(node, init);

    case _function:
      next();
      return parseFunction(node, true);

    case _if:
      next();
      node.test = parseParenExpression();
      node.consequent = parseStatement();
      node.alternate = eat(_else) ? parseStatement() : null;
      return finishNode(node, "IfStatement");

    case _return:
      if (!inFunction) raise(tokStart, "'return' außerhalb einer Funktion");
      next();

      // In `return` (and `break`/`continue`), the keywords with
      // optional arguments, we eagerly look for a semicolon or the
      // possibility to insert one.

      if (eat(_semi) || canInsertSemicolon()) node.argument = null;
      else { node.argument = parseExpression(); semicolon(); }
      return finishNode(node, "ReturnStatement");

    case _switch:
      next();
      node.discriminant = parseParenExpression();
      node.cases = [];
      expect(_braceL);
      labels.push(switchLabel);

      // Statements under must be grouped (by label) in SwitchCase
      // nodes. `cur` is used to keep the node that we are currently
      // adding statements to.

      for (var cur, sawDefault; tokType != _braceR;) {
        if (tokType === _case || tokType === _default) {
          var isCase = tokType === _case;
          if (cur) finishNode(cur, "SwitchCase");
          node.cases.push(cur = startNode());
          cur.consequent = [];
          next();
          if (isCase) cur.test = parseExpression();
          else {
            if (sawDefault) raise(lastStart, "Multiple default clauses"); sawDefault = true;
            cur.test = null;
          }
          expect(_colon);
        } else {
          if (!cur) unexpected();
          cur.consequent.push(parseStatement());
        }
      }
      if (cur) finishNode(cur, "SwitchCase");
      next(); // Closing brace
      labels.pop();
      return finishNode(node, "SwitchStatement");

    case _throw:
      next();
      if (newline.test(input.slice(lastEnd, tokStart)))
        raise(lastEnd, "Illegal newline after throw");
      node.argument = parseExpression();
      semicolon();
      return finishNode(node, "ThrowStatement");

    case _try:
      next();
      node.block = parseBlock();
      node.handler = null;
      if (tokType === _catch) {
        var clause = startNode();
        next();
        expect(_parenL);
        clause.param = parseIdent();
        if (strict && isStrictBadIdWord(clause.param.name))
          raise(clause.param.start, "Binding " + clause.param.name + " in strict mode");
        expect(_parenR);
        clause.guard = null;
        clause.body = parseBlock();
        node.handler = finishNode(clause, "CatchClause");
      }
      node.guardedHandlers = empty;
      node.finalizer = eat(_finally) ? parseBlock() : null;
      if (!node.handler && !node.finalizer)
        raise(node.start, "Missing catch or finally clause");
      return finishNode(node, "TryStatement");

    case _var:
      next();
      parseVar(node);
      semicolon();
      return finishNode(node, "VariableDeclaration");

    case _while:
      next();
      node.test = parseParenExpression();
      labels.push(loopLabel);
      node.body = parseStatement();
      labels.pop();
      return finishNode(node, "WhileStatement");

    case _with:
      if (strict) raise(tokStart, "'with' in strict mode");
      next();
      node.object = parseParenExpression();
      node.body = parseStatement();
      return finishNode(node, "WithStatement");

    case _braceL:
      return parseBlock();

    case _semi:
      next();
      return finishNode(node, "EmptyStatement");

      // If the statement does not start with a statement keyword or a
      // brace, it's an ExpressionStatement or LabeledStatement. We
      // simply start parsing an expression, and afterwards, if the
      // next token is a colon and the expression was a simple
      // Identifier node, we switch to interpreting it as a label.

    default:
      var maybeName = tokVal, expr = parseExpression();
      if (starttype === _name && expr.type === "Identifier" && eat(_colon)) {
        for (var i = 0; i < labels.length; ++i)
          if (labels[i].name === maybeName) raise(expr.start, "Label '" + maybeName + "' is already declared");
        var kind = tokType.isLoop ? "loop" : tokType === _switch ? "switch" : null;
        labels.push({name: maybeName, kind: kind});
        node.body = parseStatement();
        labels.pop();
        node.label = expr;
        return finishNode(node, "LabeledStatement");
      } else {
        node.expression = expr;
        semicolon();
        return finishNode(node, "ExpressionStatement");
      }
    }
  }

  // Used for constructs like `switch` and `if` that insist on
  // parentheses around their expression.

  function parseParenExpression() {
    expect(_parenL);
    var val = parseExpression();
    expect(_parenR);
    return val;
  }

  // Parse a semicolon-enclosed block of statements, handling `"use
  // strict"` declarations when `allowStrict` is true (used for
  // function bodies).

  function parseBlock(allowStrict) {
    var node = startNode(), first = true, strict = false, oldStrict;
    node.body = [];
    expect(_braceL);
    while (!eat(_braceR)) {
      var stmt = parseStatement();
      node.body.push(stmt);
      if (first && allowStrict && isUseStrict(stmt)) {
        oldStrict = strict;
        setStrict(strict = true);
      }
      first = false;
    }
    if (strict && !oldStrict) setStrict(false);
    return finishNode(node, "BlockStatement");
  }

  // Parse a regular `for` loop. The disambiguation code in
  // `parseStatement` will already have parsed the init statement or
  // expression.

  function parseFor(node, init) {
    node.init = init;
    expect(_semi);
    node.test = tokType === _semi ? null : parseExpression();
    expect(_semi);
    node.update = tokType === _parenR ? null : parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "ForStatement");
  }

  // Parse a `for`/`in` loop.

  function parseForIn(node, init) {
    node.left = init;
    node.right = parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "ForInStatement");
  }

  // Parse a list of variable declarations.

  function parseVar(node, noIn) {
    node.declarations = [];
    node.kind = "var";
    for (;;) {
      var decl = startNode();
      decl.id = parseIdent();
      if (strict && isStrictBadIdWord(decl.id.name))
        raise(decl.id.start, "Binding " + decl.id.name + " in strict mode");
      decl.init = eat(_eq) ? parseExpression(true, noIn) : null;
      node.declarations.push(finishNode(decl, "VariableDeclarator"));
      if (!eat(_comma)) break;
    }
    return node;
  }

  // ### Expression parsing

  // These nest, from the most general expression type at the top to
  // 'atomic', nondivisible expression types at the bottom. Most of
  // the functions will simply let the function(s) below them parse,
  // and, *if* the syntactic construct they handle is present, wrap
  // the AST node that the inner parser gave them in another node.

  // Parse a full expression. The arguments are used to forbid comma
  // sequences (in argument lists, array literals, or object literals)
  // or the `in` operator (in for loops initalization expressions).

  function parseExpression(noComma, noIn) {
    var expr = parseMaybeAssign(noIn);
    if (!noComma && tokType === _comma) {
      var node = startNodeFrom(expr);
      node.expressions = [expr];
      while (eat(_comma)) node.expressions.push(parseMaybeAssign(noIn));
      return finishNode(node, "SequenceExpression");
    }
    return expr;
  }

  // Parse an assignment expression. This includes applications of
  // operators like `+=`.

  function parseMaybeAssign(noIn) {
    var left = parseMaybeConditional(noIn);
    if (tokType.isAssign) {
      var node = startNodeFrom(left);
      node.operator = tokVal;
      node.left = left;
      next();
      node.right = parseMaybeAssign(noIn);
      checkLVal(left);
      return finishNode(node, "AssignmentExpression");
    }
    return left;
  }

  // Parse a ternary conditional (`?:`) operator.

  function parseMaybeConditional(noIn) {
    var expr = parseExprOps(noIn);
    if (eat(_question)) {
      var node = startNodeFrom(expr);
      node.test = expr;
      node.consequent = parseExpression(true);
      expect(_colon);
      node.alternate = parseExpression(true, noIn);
      return finishNode(node, "ConditionalExpression");
    }
    return expr;
  }

  // Start the precedence parser.

  function parseExprOps(noIn) {
    return parseExprOp(parseMaybeUnary(), -1, noIn);
  }

  // Parse binary operators with the operator precedence parsing
  // algorithm. `left` is the left-hand side of the operator.
  // `minPrec` provides context that allows the function to stop and
  // defer further parser to one of its callers when it encounters an
  // operator that has a lower precedence than the set it is parsing.

  function parseExprOp(left, minPrec, noIn) {
    var prec = tokType.binop;
    if (prec != null && (!noIn || tokType !== _in)) {
      if (prec > minPrec) {
        var node = startNodeFrom(left);
        node.left = left;
        node.operator = tokVal;
        var op = tokType;
        next();
        node.right = parseExprOp(parseMaybeUnary(), prec, noIn);
        var exprNode = finishNode(node, (op === _logicalOR || op === _logicalAND) ? "LogicalExpression" : "BinaryExpression");
        return parseExprOp(exprNode, minPrec, noIn);
      }
    }
    return left;
  }

  // Parse unary operators, both prefix and postfix.

  function parseMaybeUnary() {
    if (tokType.prefix) {
      var node = startNode(), update = tokType.isUpdate;
      node.operator = tokVal;
      node.prefix = true;
      tokRegexpAllowed = true;
      next();
      node.argument = parseMaybeUnary();
      if (update) checkLVal(node.argument);
      else if (strict && node.operator === "delete" &&
               node.argument.type === "Identifier")
        raise(node.start, "Deleting local variable in strict mode");
      return finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
    }
    var expr = parseExprSubscripts();
    while (tokType.postfix && !canInsertSemicolon()) {
      var node = startNodeFrom(expr);
      node.operator = tokVal;
      node.prefix = false;
      node.argument = expr;
      checkLVal(expr);
      next();
      expr = finishNode(node, "UpdateExpression");
    }
    return expr;
  }

  // Parse call, dot, and `[]`-subscript expressions.

  function parseExprSubscripts() {
    return parseSubscripts(parseExprAtom());
  }

  function parseSubscripts(base, noCalls) {
    if (eat(_dot)) {
      var node = startNodeFrom(base);
      node.object = base;
      node.property = parseIdent(true);
      node.computed = false;
      return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
    } else if (eat(_bracketL)) {
      var node = startNodeFrom(base);
      node.object = base;
      node.property = parseExpression();
      node.computed = true;
      expect(_bracketR);
      return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
    } else if (!noCalls && eat(_parenL)) {
      var node = startNodeFrom(base);
      node.callee = base;
      node.arguments = parseExprList(_parenR, false);
      return parseSubscripts(finishNode(node, "CallExpression"), noCalls);
    } else return base;
  }

  // Parse an atomic expression — either a single token that is an
  // expression, an expression started by a keyword like `function` or
  // `new`, or an expression wrapped in punctuation like `()`, `[]`,
  // or `{}`.

  function parseExprAtom() {
    switch (tokType) {
    case _this:
      var node = startNode();
      next();
      return finishNode(node, "ThisExpression");
    case _name:
      return parseIdent();
    case _num: case _string: case _regexp:
      var node = startNode();
      node.value = tokVal;
      node.raw = input.slice(tokStart, tokEnd);
      next();
      return finishNode(node, "Literal");

    case _null: case _true: case _false:
      var node = startNode();
      node.value = tokType.atomValue;
      node.raw = tokType.keyword;
      next();
      return finishNode(node, "Literal");

    case _parenL:
      var tokStartLoc1 = tokStartLoc, tokStart1 = tokStart;
      next();
      var val = parseExpression();
      val.start = tokStart1;
      val.end = tokEnd;
      if (options.locations) {
        val.loc.start = tokStartLoc1;
        val.loc.end = tokEndLoc;
      }
      if (options.ranges)
        val.range = [tokStart1, tokEnd];
      expect(_parenR);
      return val;

    case _bracketL:
      var node = startNode();
      next();
      node.elements = parseExprList(_bracketR, true, true);
      return finishNode(node, "ArrayExpression");

    case _braceL:
      return parseObj();

    case _function:
      var node = startNode();
      next();
      return parseFunction(node, false);

    case _new:
      return parseNew();

    default:
      unexpected();
    }
  }

  // New's precedence is slightly tricky. It must allow its argument
  // to be a `[]` or dot subscript expression, but not a call — at
  // least, not without wrapping it in parentheses. Thus, it uses the

  function parseNew() {
    var node = startNode();
    next();
    node.callee = parseSubscripts(parseExprAtom(), true);
    if (eat(_parenL)) node.arguments = parseExprList(_parenR, false);
    else node.arguments = empty;
    return finishNode(node, "NewExpression");
  }

  // Parse an object literal.

  function parseObj() {
    var node = startNode(), first = true, sawGetSet = false;
    node.properties = [];
    next();
    while (!eat(_braceR)) {
      if (!first) {
        expect(_comma);
        if (options.allowTrailingCommas && eat(_braceR)) break;
      } else first = false;

      var prop = {key: parsePropertyName()}, isGetSet = false, kind;
      if (eat(_colon)) {
        prop.value = parseExpression(true);
        kind = prop.kind = "init";
      } else if (options.ecmaVersion >= 5 && prop.key.type === "Identifier" &&
                 (prop.key.name === "get" || prop.key.name === "set")) {
        isGetSet = sawGetSet = true;
        kind = prop.kind = prop.key.name;
        prop.key = parsePropertyName();
        if (tokType !== _parenL) unexpected();
        prop.value = parseFunction(startNode(), false);
      } else unexpected();

      // getters and setters are not allowed to clash — either with
      // each other or with an init property — and in strict mode,
      // init properties are also not allowed to be repeated.

      if (prop.key.type === "Identifier" && (strict || sawGetSet)) {
        for (var i = 0; i < node.properties.length; ++i) {
          var other = node.properties[i];
          if (other.key.name === prop.key.name) {
            var conflict = kind == other.kind || isGetSet && other.kind === "init" ||
              kind === "init" && (other.kind === "get" || other.kind === "set");
            if (conflict && !strict && kind === "init" && other.kind === "init") conflict = false;
            if (conflict) raise(prop.key.start, "Redefinition of property");
          }
        }
      }
      node.properties.push(prop);
    }
    return finishNode(node, "ObjectExpression");
  }

  function parsePropertyName() {
    if (tokType === _num || tokType === _string) return parseExprAtom();
    return parseIdent(true);
  }

  // Parse a function declaration or literal (depending on the
  // `isStatement` parameter).

  function parseFunction(node, isStatement) {
    if (tokType === _name) node.id = parseIdent();
    else if (isStatement) unexpected();
    else node.id = null;
    node.params = [];
    var first = true;
    expect(_parenL);
    while (!eat(_parenR)) {
      if (!first) expect(_comma); else first = false;
      node.params.push(parseIdent());
    }

    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    var oldInFunc = inFunction, oldLabels = labels;
    inFunction = true; labels = [];
    node.body = parseBlock(true);
    inFunction = oldInFunc; labels = oldLabels;

    // If this is a strict mode function, verify that argument names
    // are not repeated, and it does not try to bind the words `eval`
    // or `arguments`.
    if (strict || node.body.body.length && isUseStrict(node.body.body[0])) {
      for (var i = node.id ? -1 : 0; i < node.params.length; ++i) {
        var id = i < 0 ? node.id : node.params[i];
        if (isStrictReservedWord(id.name) || isStrictBadIdWord(id.name))
          raise(id.start, "Defining '" + id.name + "' in strict mode");
        if (i >= 0) for (var j = 0; j < i; ++j) if (id.name === node.params[j].name)
          raise(id.start, "Argument name clash in strict mode");
      }
    }

    return finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
  }

  // Parses a comma-separated list of expressions, and returns them as
  // an array. `close` is the token type that ends the list, and
  // `allowEmpty` can be turned on to allow subsequent commas with
  // nothing in between them to be parsed as `null` (which is needed
  // for array literals).

  function parseExprList(close, allowTrailingComma, allowEmpty) {
    var elts = [], first = true;
    while (!eat(close)) {
      if (!first) {
        expect(_comma);
        if (allowTrailingComma && options.allowTrailingCommas && eat(close)) break;
      } else first = false;

      if (allowEmpty && tokType === _comma) elts.push(null);
      else elts.push(parseExpression(true));
    }
    return elts;
  }

  // Parse the next token as an identifier. If `liberal` is true (used
  // when parsing properties), it will also convert keywords into
  // identifiers.

  function parseIdent(liberal) {
    var node = startNode();
    node.name = tokType === _name ? tokVal : (liberal && !options.forbidReserved && tokType.keyword) || unexpected();
    tokRegexpAllowed = false;
    next();
    return finishNode(node, "Identifier");
  }

});

(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
	typeof define === 'function' && define.amd ? define(['exports'], factory) :
	(factory((global.acorn = global.acorn || {}, global.acorn.walk = {})));
}(this, (function (exports) { 'use strict';

// AST walker module for Mozilla Parser API compatible trees

// A simple walk is one where you simply specify callbacks to be
// called on specific nodes. The last two arguments are optional. A
// simple use would be
//
//     walk.simple(myTree, {
//         Expression: function(node) { ... }
//     });
//
// to do something with all expressions. All Parser API node types
// can be used to identify node types, as well as Expression,
// Statement, and ScopeBody, which denote categories of nodes.
//
// The base argument can be used to pass a custom (recursive)
// walker, and state can be used to give this walked an initial
// state.

function simple(node, visitors, baseVisitor, state, override) {
  if (!baseVisitor) { baseVisitor = base
  ; }(function c(node, st, override) {
    var type = override || node.type, found = visitors[type];
    baseVisitor[type](node, st, c);
    if (found) { found(node, st); }
  })(node, state, override);
}

// An ancestor walk keeps an array of ancestor nodes (including the
// current node) and passes them to the callback as third parameter
// (and also as state parameter when no other state is present).
function ancestor(node, visitors, baseVisitor, state) {
  var ancestors = [];
  if (!baseVisitor) { baseVisitor = base
  ; }(function c(node, st, override) {
    var type = override || node.type, found = visitors[type];
    var isNew = node !== ancestors[ancestors.length - 1];
    if (isNew) { ancestors.push(node); }
    baseVisitor[type](node, st, c);
    if (found) { found(node, st || ancestors, ancestors); }
    if (isNew) { ancestors.pop(); }
  })(node, state);
}

// A recursive walk is one where your functions override the default
// walkers. They can modify and replace the state parameter that's
// threaded through the walk, and can opt how and whether to walk
// their child nodes (by calling their third argument on these
// nodes).
function recursive(node, state, funcs, baseVisitor, override) {
  var visitor = funcs ? make(funcs, baseVisitor || undefined) : baseVisitor;(function c(node, st, override) {
    visitor[override || node.type](node, st, c);
  })(node, state, override);
}

function makeTest(test) {
  if (typeof test === "string")
    { return function (type) { return type === test; } }
  else if (!test)
    { return function () { return true; } }
  else
    { return test }
}

var Found = function Found(node, state) { this.node = node; this.state = state; };

// A full walk triggers the callback on each node
function full(node, callback, baseVisitor, state, override) {
  if (!baseVisitor) { baseVisitor = base
  ; }(function c(node, st, override) {
    var type = override || node.type;
    baseVisitor[type](node, st, c);
    if (!override) { callback(node, st, type); }
  })(node, state, override);
}

// An fullAncestor walk is like an ancestor walk, but triggers
// the callback on each node
function fullAncestor(node, callback, baseVisitor, state) {
  if (!baseVisitor) { baseVisitor = base; }
  var ancestors = [];(function c(node, st, override) {
    var type = override || node.type;
    var isNew = node !== ancestors[ancestors.length - 1];
    if (isNew) { ancestors.push(node); }
    baseVisitor[type](node, st, c);
    if (!override) { callback(node, st || ancestors, ancestors, type); }
    if (isNew) { ancestors.pop(); }
  })(node, state);
}

// Find a node with a given start, end, and type (all are optional,
// null can be used as wildcard). Returns a {node, state} object, or
// undefined when it doesn't find a matching node.
function findNodeAt(node, start, end, test, baseVisitor, state) {
  if (!baseVisitor) { baseVisitor = base; }
  test = makeTest(test);
  try {
    (function c(node, st, override) {
      var type = override || node.type;
      if ((start == null || node.start <= start) &&
          (end == null || node.end >= end))
        { baseVisitor[type](node, st, c); }
      if ((start == null || node.start === start) &&
          (end == null || node.end === end) &&
          test(type, node))
        { throw new Found(node, st) }
    })(node, state);
  } catch (e) {
    if (e instanceof Found) { return e }
    throw e
  }
}

// Find the innermost node of a given type that contains the given
// position. Interface similar to findNodeAt.
function findNodeAround(node, pos, test, baseVisitor, state) {
  test = makeTest(test);
  if (!baseVisitor) { baseVisitor = base; }
  try {
    (function c(node, st, override) {
      var type = override || node.type;
      if (node.start > pos || node.end < pos) { return }
      baseVisitor[type](node, st, c);
      if (test(type, node)) { throw new Found(node, st) }
    })(node, state);
  } catch (e) {
    if (e instanceof Found) { return e }
    throw e
  }
}

// Find the outermost matching node after a given position.
function findNodeAfter(node, pos, test, baseVisitor, state) {
  test = makeTest(test);
  if (!baseVisitor) { baseVisitor = base; }
  try {
    (function c(node, st, override) {
      if (node.end < pos) { return }
      var type = override || node.type;
      if (node.start >= pos && test(type, node)) { throw new Found(node, st) }
      baseVisitor[type](node, st, c);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) { return e }
    throw e
  }
}

// Find the outermost matching node before a given position.
function findNodeBefore(node, pos, test, baseVisitor, state) {
  test = makeTest(test);
  if (!baseVisitor) { baseVisitor = base; }
  var max;(function c(node, st, override) {
    if (node.start > pos) { return }
    var type = override || node.type;
    if (node.end <= pos && (!max || max.node.end < node.end) && test(type, node))
      { max = new Found(node, st); }
    baseVisitor[type](node, st, c);
  })(node, state);
  return max
}

// Fallback to an Object.create polyfill for older environments.
var create = Object.create || function(proto) {
  function Ctor() {}
  Ctor.prototype = proto;
  return new Ctor
};

// Used to create a custom walker. Will fill in all missing node
// type properties with the defaults.
function make(funcs, baseVisitor) {
  var visitor = create(baseVisitor || base);
  for (var type in funcs) { visitor[type] = funcs[type]; }
  return visitor
}

function skipThrough(node, st, c) { c(node, st); }
function ignore(_node, _st, _c) {}

// Node walkers.

var base = {};

base.Program = base.BlockStatement = function (node, st, c) {
  for (var i = 0, list = node.body; i < list.length; i += 1)
    {
    var stmt = list[i];

    c(stmt, st, "Statement");
  }
};
base.Statement = skipThrough;
base.EmptyStatement = ignore;
base.ExpressionStatement = base.ParenthesizedExpression =
  function (node, st, c) { return c(node.expression, st, "Expression"); };
base.IfStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Statement");
  if (node.alternate) { c(node.alternate, st, "Statement"); }
};
base.LabeledStatement = function (node, st, c) { return c(node.body, st, "Statement"); };
base.BreakStatement = base.ContinueStatement = ignore;
base.WithStatement = function (node, st, c) {
  c(node.object, st, "Expression");
  c(node.body, st, "Statement");
};
base.SwitchStatement = function (node, st, c) {
  c(node.discriminant, st, "Expression");
  for (var i = 0, list = node.cases; i < list.length; i += 1) {
    var cs = list[i];

    if (cs.test) { c(cs.test, st, "Expression"); }
    for (var i$1 = 0, list$1 = cs.consequent; i$1 < list$1.length; i$1 += 1)
      {
      var cons = list$1[i$1];

      c(cons, st, "Statement");
    }
  }
};
base.SwitchCase = function (node, st, c) {
  if (node.test) { c(node.test, st, "Expression"); }
  for (var i = 0, list = node.consequent; i < list.length; i += 1)
    {
    var cons = list[i];

    c(cons, st, "Statement");
  }
};
base.ReturnStatement = base.YieldExpression = base.AwaitExpression = function (node, st, c) {
  if (node.argument) { c(node.argument, st, "Expression"); }
};
base.ThrowStatement = base.SpreadElement =
  function (node, st, c) { return c(node.argument, st, "Expression"); };
base.TryStatement = function (node, st, c) {
  c(node.block, st, "Statement");
  if (node.handler) { c(node.handler, st); }
  if (node.finalizer) { c(node.finalizer, st, "Statement"); }
};
base.CatchClause = function (node, st, c) {
  if (node.param) { c(node.param, st, "Pattern"); }
  c(node.body, st, "ScopeBody");
};
base.WhileStatement = base.DoWhileStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForStatement = function (node, st, c) {
  if (node.init) { c(node.init, st, "ForInit"); }
  if (node.test) { c(node.test, st, "Expression"); }
  if (node.update) { c(node.update, st, "Expression"); }
  c(node.body, st, "Statement");
};
base.ForInStatement = base.ForOfStatement = function (node, st, c) {
  c(node.left, st, "ForInit");
  c(node.right, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInit = function (node, st, c) {
  if (node.type === "VariableDeclaration") { c(node, st); }
  else { c(node, st, "Expression"); }
};
base.DebuggerStatement = ignore;

base.FunctionDeclaration = function (node, st, c) { return c(node, st, "Function"); };
base.VariableDeclaration = function (node, st, c) {
  for (var i = 0, list = node.declarations; i < list.length; i += 1)
    {
    var decl = list[i];

    c(decl, st);
  }
};
base.VariableDeclarator = function (node, st, c) {
  c(node.id, st, "Pattern");
  if (node.init) { c(node.init, st, "Expression"); }
};

base.Function = function (node, st, c) {
  if (node.id) { c(node.id, st, "Pattern"); }
  for (var i = 0, list = node.params; i < list.length; i += 1)
    {
    var param = list[i];

    c(param, st, "Pattern");
  }
  c(node.body, st, node.expression ? "ScopeExpression" : "ScopeBody");
};
// FIXME drop these node types in next major version
// (They are awkward, and in ES6 every block can be a scope.)
base.ScopeBody = function (node, st, c) { return c(node, st, "Statement"); };
base.ScopeExpression = function (node, st, c) { return c(node, st, "Expression"); };

base.Pattern = function (node, st, c) {
  if (node.type === "Identifier")
    { c(node, st, "VariablePattern"); }
  else if (node.type === "MemberExpression")
    { c(node, st, "MemberPattern"); }
  else
    { c(node, st); }
};
base.VariablePattern = ignore;
base.MemberPattern = skipThrough;
base.RestElement = function (node, st, c) { return c(node.argument, st, "Pattern"); };
base.ArrayPattern = function (node, st, c) {
  for (var i = 0, list = node.elements; i < list.length; i += 1) {
    var elt = list[i];

    if (elt) { c(elt, st, "Pattern"); }
  }
};
base.ObjectPattern = function (node, st, c) {
  for (var i = 0, list = node.properties; i < list.length; i += 1) {
    var prop = list[i];

    if (prop.type === "Property") {
      if (prop.computed) { c(prop.key, st, "Expression"); }
      c(prop.value, st, "Pattern");
    } else if (prop.type === "RestElement") {
      c(prop.argument, st, "Pattern");
    }
  }
};

base.Expression = skipThrough;
base.ThisExpression = base.Super = base.MetaProperty = ignore;
base.ArrayExpression = function (node, st, c) {
  for (var i = 0, list = node.elements; i < list.length; i += 1) {
    var elt = list[i];

    if (elt) { c(elt, st, "Expression"); }
  }
};
base.ObjectExpression = function (node, st, c) {
  for (var i = 0, list = node.properties; i < list.length; i += 1)
    {
    var prop = list[i];

    c(prop, st);
  }
};
base.FunctionExpression = base.ArrowFunctionExpression = base.FunctionDeclaration;
base.SequenceExpression = base.TemplateLiteral = function (node, st, c) {
  for (var i = 0, list = node.expressions; i < list.length; i += 1)
    {
    var expr = list[i];

    c(expr, st, "Expression");
  }
};
base.UnaryExpression = base.UpdateExpression = function (node, st, c) {
  c(node.argument, st, "Expression");
};
base.BinaryExpression = base.LogicalExpression = function (node, st, c) {
  c(node.left, st, "Expression");
  c(node.right, st, "Expression");
};
base.AssignmentExpression = base.AssignmentPattern = function (node, st, c) {
  c(node.left, st, "Pattern");
  c(node.right, st, "Expression");
};
base.ConditionalExpression = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Expression");
  c(node.alternate, st, "Expression");
};
base.NewExpression = base.CallExpression = function (node, st, c) {
  c(node.callee, st, "Expression");
  if (node.arguments)
    { for (var i = 0, list = node.arguments; i < list.length; i += 1)
      {
        var arg = list[i];

        c(arg, st, "Expression");
      } }
};
base.MemberExpression = function (node, st, c) {
  c(node.object, st, "Expression");
  if (node.computed) { c(node.property, st, "Expression"); }
};
base.ExportNamedDeclaration = base.ExportDefaultDeclaration = function (node, st, c) {
  if (node.declaration)
    { c(node.declaration, st, node.type === "ExportNamedDeclaration" || node.declaration.id ? "Statement" : "Expression"); }
  if (node.source) { c(node.source, st, "Expression"); }
};
base.ExportAllDeclaration = function (node, st, c) {
  c(node.source, st, "Expression");
};
base.ImportDeclaration = function (node, st, c) {
  for (var i = 0, list = node.specifiers; i < list.length; i += 1)
    {
    var spec = list[i];

    c(spec, st);
  }
  c(node.source, st, "Expression");
};
base.ImportSpecifier = base.ImportDefaultSpecifier = base.ImportNamespaceSpecifier = base.Identifier = base.Literal = ignore;

base.TaggedTemplateExpression = function (node, st, c) {
  c(node.tag, st, "Expression");
  c(node.quasi, st, "Expression");
};
base.ClassDeclaration = base.ClassExpression = function (node, st, c) { return c(node, st, "Class"); };
base.Class = function (node, st, c) {
  if (node.id) { c(node.id, st, "Pattern"); }
  if (node.superClass) { c(node.superClass, st, "Expression"); }
  c(node.body, st);
};
base.ClassBody = function (node, st, c) {
  for (var i = 0, list = node.body; i < list.length; i += 1)
    {
    var elt = list[i];

    c(elt, st);
  }
};
base.MethodDefinition = base.Property = function (node, st, c) {
  if (node.computed) { c(node.key, st, "Expression"); }
  c(node.value, st, "Expression");
};

exports.simple = simple;
exports.ancestor = ancestor;
exports.recursive = recursive;
exports.full = full;
exports.fullAncestor = fullAncestor;
exports.findNodeAt = findNodeAt;
exports.findNodeAround = findNodeAround;
exports.findNodeAfter = findNodeAfter;
exports.findNodeBefore = findNodeBefore;
exports.make = make;
exports.base = base;

Object.defineProperty(exports, '__esModule', { value: true });

})));

/**
 * @license
 * JavaScript Interpreter
 *
 * Copyright 2013 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Interpreting JavaScript in JavaScript.
 * @author fraser@google.com (Neil Fraser)
 */
'use strict';

/**
 * Create a new interpreter.
 * @param {string|!Object} code Raw JavaScript text or AST.
 * @param {Function=} opt_initFunc Optional initialization function.  Used to
 *     define APIs.  When called it is passed the interpreter object and the
 *     global scope object.
 * @constructor
 */
var Interpreter = function(code, opt_initFunc) {
  if (typeof code === 'string') {
    code = acorn.parse(code, Interpreter.PARSE_OPTIONS);
  }
  this.ast = code;
  this.initFunc_ = opt_initFunc;
  this.paused_ = false;
  this.polyfills_ = [];
  // Unique identifier for native functions.  Used in serialization.
  this.functionCounter_ = 0;
  // Map node types to our step function names; a property lookup is faster
  // than string concatenation with "step" prefix.
  this.stepFunctions_ = Object.create(null);
  var stepMatch = /^step([A-Z]\w*)$/;
  var m;
  for (var methodName in this) {
    if ((typeof this[methodName] === 'function') &&
        (m = methodName.match(stepMatch))) {
      this.stepFunctions_[m[1]] = this[methodName].bind(this);
    }
  }
  // Create and initialize the global scope.
  this.global = this.createScope(this.ast, null);
  // Run the polyfills.
  this.ast = acorn.parse(this.polyfills_.join('\n'), Interpreter.PARSE_OPTIONS);
  this.polyfills_ = undefined;  // Allow polyfill strings to garbage collect.
  this.stripLocations_(this.ast, undefined, undefined);
  var state = new Interpreter.State(this.ast, this.global);
  state.done = false;
  this.stateStack = [state];
  this.run();
  this.value = undefined;
  // Point at the main program.
  this.ast = code;
  var state = new Interpreter.State(this.ast, this.global);
  state.done = false;
  this.stateStack.length = 0;
  this.stateStack[0] = state;
  // Get a handle on Acorn's node_t object.  It's tricky to access.
  this.nodeConstructor = state.node.constructor;
  // Preserve publicly properties from being pruned/renamed by JS compilers.
  // Add others as needed.
  this['stateStack'] = this.stateStack;
  this['OBJECT'] = this.OBJECT; this['OBJECT_PROTO'] = this.OBJECT_PROTO;
  this['FUNCTION'] = this.FUNCTION; this['FUNCTION_PROTO'] = this.FUNCTION_PROTO;
  this['ARRAY'] = this.ARRAY; this['ARRAY_PROTO'] = this.ARRAY_PROTO;
  this['REGEXP'] = this.REGEXP; this['REGEXP_PROTO'] = this.REGEXP_PROTO;
  // The following properties are obsolete.  Do not use.
  this['UNDEFINED'] = undefined; this['NULL'] = null; this['NAN'] = NaN;
  this['TRUE'] = true; this['FALSE'] = false; this['STRING_EMPTY'] = '';
  this['NUMBER_ZERO'] = 0; this['NUMBER_ONE'] = 1;
};

/**
 * @const {!Object} Configuration used for all Acorn parsing.
 */
Interpreter.PARSE_OPTIONS = {
  ecmaVersion: 5
};

/**
 * Property descriptor of readonly properties.
 */
Interpreter.READONLY_DESCRIPTOR = {
  configurable: true,
  enumerable: true,
  writable: false
};

/**
 * Property descriptor of non-enumerable properties.
 */
Interpreter.NONENUMERABLE_DESCRIPTOR = {
  configurable: true,
  enumerable: false,
  writable: true
};

/**
 * Property descriptor of readonly, non-enumerable properties.
 */
Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR = {
  configurable: true,
  enumerable: false,
  writable: false
};

/**
 * Property descriptor of variables.
 */
Interpreter.VARIABLE_DESCRIPTOR = {
  configurable: false,
  enumerable: true,
  writable: true
};

/**
 * Unique symbol for indicating that a step has encountered an error, has
 * added it to the stack, and will be thrown within the user's program.
 * When STEP_ERROR is thrown in the JS-Interpreter, the error can be ignored.
 */
Interpreter.STEP_ERROR = {};

/**
 * Unique symbol for indicating that a reference is a variable on the scope,
 * not an object property.
 */
Interpreter.SCOPE_REFERENCE = {};

/**
 * For cycle detection in array to string and error conversion;
 * see spec bug github.com/tc39/ecma262/issues/289
 * Since this is for atomic actions only, it can be a class property.
 */
Interpreter.toStringCycles_ = [];

/**
 * Add more code to the interpreter.
 * @param {string|!Object} code Raw JavaScript text or AST.
 */
Interpreter.prototype.appendCode = function(code) {
  var state = this.stateStack[0];
  if (!state || state.node['type'] !== 'Program') {
    throw Error('Expecting original AST to start with a Program node.');
  }
  if (typeof code === 'string') {
    code = acorn.parse(code, Interpreter.PARSE_OPTIONS);
  }
  if (!code || code['type'] !== 'Program') {
    throw Error('Expecting new AST to start with a Program node.');
  }
  this.populateScope_(code, state.scope);
  // Append the new program to the old one.
  for (var i = 0, node; (node = code['body'][i]); i++) {
    state.node['body'].push(node);
  }
  state.done = false;
};

/**
 * Execute one step of the interpreter.
 * @return {boolean} True if a step was executed, false if no more instructions.
 */
Interpreter.prototype.step = function() {
  var stack = this.stateStack;
  var state = stack[stack.length - 1];
  if (!state) {
    return false;
  }
  var node = state.node, type = node['type'];
  if (type === 'Program' && state.done) {
    return false;
  } else if (this.paused_) {
    return true;
  }
  try {
    var nextState = this.stepFunctions_[type](stack, state, node);
  } catch (e) {
    // Eat any step errors.  They have been thrown on the stack.
    if (e !== Interpreter.STEP_ERROR) {
      // Uh oh.  This is a real error in the JS-Interpreter.  Rethrow.
      throw e;
    }
  }
  if (nextState) {
    stack.push(nextState);
  }
  if (!node['end']) {
    // This is polyfill code.  Keep executing until we arrive at user code.
    return this.step();
  }
  return true;
};

/**
 * Execute the interpreter to program completion.  Vulnerable to infinite loops.
 * @return {boolean} True if a execution is asynchronously blocked,
 *     false if no more instructions.
 */
Interpreter.prototype.run = function() {
  while (!this.paused_ && this.step()) {}
  return this.paused_;
};

/**
 * Initialize the global scope with buitin properties and functions.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initGlobalScope = function(scope) {
  // Initialize uneditable global properties.
  this.setProperty(scope, 'NaN', NaN,
                   Interpreter.READONLY_DESCRIPTOR);
  this.setProperty(scope, 'Infinity', Infinity,
                   Interpreter.READONLY_DESCRIPTOR);
  this.setProperty(scope, 'undefined', undefined,
                   Interpreter.READONLY_DESCRIPTOR);
  this.setProperty(scope, 'window', scope,
                   Interpreter.READONLY_DESCRIPTOR);
  this.setProperty(scope, 'this', scope,
                   Interpreter.READONLY_DESCRIPTOR);
  this.setProperty(scope, 'self', scope); // Editable.

  // Create the objects which will become Object.prototype and
  // Function.prototype, which are needed to bootstrap everything else.
  this.OBJECT_PROTO = new Interpreter.Object(null);
  this.FUNCTION_PROTO = new Interpreter.Object(this.OBJECT_PROTO);
  // Initialize global objects.
  this.initFunction(scope);
  this.initObject(scope);
  // Unable to set scope's parent prior (OBJECT did not exist).
  // Note that in a browser this would be 'Window', whereas in Node.js it would
  // be 'Object'.  This interpreter is closer to Node in that it has no DOM.
  scope.proto = this.OBJECT_PROTO;
  this.setProperty(scope, 'constructor', this.OBJECT);
  this.initArray(scope);
  this.initString(scope);
  this.initBoolean(scope);
  this.initNumber(scope);
  this.initDate(scope);
  this.initRegExp(scope);
  this.initError(scope);
  this.initMath(scope);
  this.initJSON(scope);

  // Initialize global functions.
  var thisInterpreter = this;
  var func = this.createNativeFunction(
      function(x) {throw EvalError("Can't happen");}, false);
  func.eval = true;
  this.setProperty(scope, 'eval', func);

  this.setProperty(scope, 'parseInt',
      this.createNativeFunction(parseInt, false));
  this.setProperty(scope, 'parseFloat',
      this.createNativeFunction(parseFloat, false));

  this.setProperty(scope, 'isNaN',
      this.createNativeFunction(isNaN, false));

  this.setProperty(scope, 'isFinite',
      this.createNativeFunction(isFinite, false));

  var strFunctions = [
    [escape, 'escape'], [unescape, 'unescape'],
    [decodeURI, 'decodeURI'], [decodeURIComponent, 'decodeURIComponent'],
    [encodeURI, 'encodeURI'], [encodeURIComponent, 'encodeURIComponent']
  ];
  for (var i = 0; i < strFunctions.length; i++) {
    var wrapper = (function(nativeFunc) {
      return function(str) {
        try {
          return nativeFunc(str);
        } catch (e) {
          // decodeURI('%xy') will throw an error.  Catch and rethrow.
          thisInterpreter.throwException(thisInterpreter.URI_ERROR, e.message);
        }
      };
    })(strFunctions[i][0]);
    this.setProperty(scope, strFunctions[i][1],
        this.createNativeFunction(wrapper, false),
        Interpreter.NONENUMERABLE_DESCRIPTOR);
  }

  // Run any user-provided initialization.
  if (this.initFunc_) {
    this.initFunc_(this, scope);
  }
};

/**
 * Initialize the Function class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initFunction = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  var identifierRegexp = /^[A-Za-z_$][\w$]*$/;
  // Function constructor.
  wrapper = function(var_args) {
    if (thisInterpreter.calledWithNew()) {
      // Called as new Function().
      var newFunc = this;
    } else {
      // Called as Function().
      var newFunc =
          thisInterpreter.createObjectProto(thisInterpreter.FUNCTION_PROTO);
    }
    if (arguments.length) {
      var code = String(arguments[arguments.length - 1]);
    } else {
      var code = '';
    }
    var args = [];
    for (var i = 0; i < arguments.length - 1; i++) {
      var name = String(arguments[i]);
      if (!name.match(identifierRegexp)) {
        thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
            'Ungültiger Funktions Parameter: ' + name);
      }
      args.push(name);
    }
    args = args.join(', ');
    // Interestingly, the scope for constructed functions is the global scope,
    // even if they were constructed in some other scope.
    newFunc.parentScope = thisInterpreter.global;
    // Acorn needs to parse code in the context of a function or else 'return'
    // statements will be syntax errors.
    try {
    var ast = acorn.parse('$ = function(' + args + ') {' + code + '};',
        Interpreter.PARSE_OPTIONS);
    } catch (e) {
      // Acorn threw a SyntaxError.  Rethrow as a trappable error.
      thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
          'Invalid code: ' + e.message);
    }
    if (ast['body'].length !== 1) {
      // Function('a', 'return a + 6;}; {alert(1);');
      thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
          'Invalid code in function body.');
    }
    newFunc.node = ast['body'][0]['expression']['right'];
    thisInterpreter.setProperty(newFunc, 'length', newFunc.node['length'],
        Interpreter.READONLY_DESCRIPTOR);
    return newFunc;
  };
  wrapper.id = this.functionCounter_++;
  this.FUNCTION = this.createObjectProto(this.FUNCTION_PROTO);

  this.setProperty(scope, 'Function', this.FUNCTION);
  // Manually setup type and prototype because createObj doesn't recognize
  // this object as a function (this.FUNCTION did not exist).
  this.setProperty(this.FUNCTION, 'prototype', this.FUNCTION_PROTO);
  this.FUNCTION.nativeFunc = wrapper;

  // Configure Function.prototype.
  this.setProperty(this.FUNCTION_PROTO, 'constructor', this.FUNCTION,
                   Interpreter.NONENUMERABLE_DESCRIPTOR);
  this.FUNCTION_PROTO.nativeFunc = function() {};
  this.FUNCTION_PROTO.nativeFunc.id = this.functionCounter_++;
  this.setProperty(this.FUNCTION_PROTO, 'length', 0,
      Interpreter.READONLY_DESCRIPTOR);

  var boxThis = function(value) {
    // In non-strict mode 'this' must be an object.
    if ((!value || !value.isObject) && !thisInterpreter.getScope().strict) {
      if (value === undefined || value === null) {
        // 'Undefined' and 'null' are changed to global object.
        value = thisInterpreter.global;
      } else {
        // Primitives must be boxed in non-strict mode.
        var box = thisInterpreter.createObjectProto(
            thisInterpreter.getPrototype(value));
        box.data = value;
        value = box;
      }
    }
    return value;
  };

  wrapper = function(thisArg, args) {
    var state =
        thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
    // Rewrite the current 'CallExpression' to apply a different function.
    state.func_ = this;
    // Assign the 'this' object.
    state.funcThis_ = boxThis(thisArg);
    // Bind any provided arguments.
    state.arguments_ = [];
    if (args !== null && args !== undefined) {
      if (args.isObject) {
        state.arguments_ = thisInterpreter.pseudoToNative(args);
      } else {
        thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
            'CreateListFromArrayLike called on non-object');
      }
    }
    state.doneExec_ = false;
  };
  this.setNativeFunctionPrototype(this.FUNCTION, 'apply', wrapper);

  wrapper = function(thisArg, var_args) {
    var state =
        thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
    // Rewrite the current 'CallExpression' to call a different function.
    state.func_ = this;
    // Assign the 'this' object.
    state.funcThis_ = boxThis(thisArg);
    // Bind any provided arguments.
    state.arguments_ = [];
    for (var i = 1; i < arguments.length; i++) {
      state.arguments_.push(arguments[i]);
    }
    state.doneExec_ = false;
  };
  this.setNativeFunctionPrototype(this.FUNCTION, 'call', wrapper);

  this.polyfills_.push(
// Polyfill copied from:
// developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_objects/Function/bind
"Object.defineProperty(Function.prototype, 'bind',",
    "{configurable: true, writable: true, value:",
  "function(oThis) {",
    "if (typeof this !== 'function') {",
      "throw TypeError('What is trying to be bound is not callable');",
    "}",
    "var aArgs   = Array.prototype.slice.call(arguments, 1),",
        "fToBind = this,",
        "fNOP    = function() {},",
        "fBound  = function() {",
          "return fToBind.apply(this instanceof fNOP",
                 "? this",
                 ": oThis,",
                 "aArgs.concat(Array.prototype.slice.call(arguments)));",
        "};",
    "if (this.prototype) {",
      "fNOP.prototype = this.prototype;",
    "}",
    "fBound.prototype = new fNOP();",
    "return fBound;",
  "}",
"});",
"");

  // Function has no parent to inherit from, so it needs its own mandatory
  // toString and valueOf functions.
  wrapper = function() {
    return this.toString();
  };
  this.setNativeFunctionPrototype(this.FUNCTION, 'toString', wrapper);
  this.setProperty(this.FUNCTION, 'toString',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);
  wrapper = function() {
    return this.valueOf();
  };
  this.setNativeFunctionPrototype(this.FUNCTION, 'valueOf', wrapper);
  this.setProperty(this.FUNCTION, 'valueOf',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);
};

/**
 * Initialize the Object class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initObject = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // Object constructor.
  wrapper = function(value) {
    if (value === undefined || value === null) {
      // Create a new object.
      if (thisInterpreter.calledWithNew()) {
        // Called as new Object().
        return this;
      } else {
        // Called as Object().
        return thisInterpreter.createObjectProto(thisInterpreter.OBJECT_PROTO);
      }
    }
    if (!value.isObject) {
      // Wrap the value as an object.
      var box = thisInterpreter.createObjectProto(
          thisInterpreter.getPrototype(value));
      box.data = value;
      return box;
    }
    // Return the provided object.
    return value;
  };
  this.OBJECT = this.createNativeFunction(wrapper, true);
  // Throw away the created prototype and use the root prototype.
  this.setProperty(this.OBJECT, 'prototype', this.OBJECT_PROTO);
  this.setProperty(this.OBJECT_PROTO, 'constructor', this.OBJECT);
  this.setProperty(scope, 'Object', this.OBJECT);

  /**
   * Checks if the provided value is null or undefined.
   * If so, then throw an error in the call stack.
   * @param {Interpreter.Value} value Value to check.
   */
  var throwIfNullUndefined = function(value) {
    if (value === undefined || value === null) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          "Cannot convert '" + value + "' to object");
    }
  };

  // Static methods on Object.
  wrapper = function(obj) {
    throwIfNullUndefined(obj);
    var props = obj.isObject ? obj.properties : obj;
    return thisInterpreter.nativeToPseudo(Object.getOwnPropertyNames(props));
  };
  this.setProperty(this.OBJECT, 'getOwnPropertyNames',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  wrapper = function(obj) {
    throwIfNullUndefined(obj);
    if (!obj.isObject) {
      return thisInterpreter.nativeToPseudo(Object.keys(obj));
    }
    return thisInterpreter.nativeToPseudo(Object.keys(obj.properties));
  };
  this.setProperty(this.OBJECT, 'keys',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  wrapper = function(proto) {
    // Support for the second argument is the responsibility of a polyfill.
    if (proto === null) {
      return thisInterpreter.createObjectProto(null);
    }
    if (proto === undefined || !proto.isObject) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          'Object prototype may only be an Object or null');
    }
    return thisInterpreter.createObjectProto(proto);
  };
  this.setProperty(this.OBJECT, 'create',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  // Add a polyfill to handle create's second argument.
  this.polyfills_.push(
"(function() {",
  "var create_ = Object.create;",
  "Object.create = function(proto, props) {",
    "var obj = create_(proto);",
    "props && Object.defineProperties(obj, props);",
    "return obj;",
  "};",
"})();",
"");

  wrapper = function(obj, prop, descriptor) {
    prop = String(prop);
    if (!obj || !obj.isObject) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          'Object.defineProperty called on non-object');
    }
    if (!descriptor || !descriptor.isObject) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          'Property description must be an object');
    }
    if (!obj.properties[prop] && obj.preventExtensions) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          "Can't define property '" + prop + "', object is not extensible");
    }
    // The polyfill guarantees no inheritance and no getter functions.
    // Therefore the descriptor properties map is the native object needed.
    thisInterpreter.setProperty(obj, prop, ReferenceError,
                                descriptor.properties);
    return obj;
  };
  this.setProperty(this.OBJECT, 'defineProperty',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  this.polyfills_.push(
// Flatten the descriptor to remove any inheritance or getter functions.
"(function() {",
  "var defineProperty_ = Object.defineProperty;",
  "Object.defineProperty = function(obj, prop, d1) {",
    "var d2 = {};",
    "if ('configurable' in d1) d2.configurable = d1.configurable;",
    "if ('enumerable' in d1) d2.enumerable = d1.enumerable;",
    "if ('writable' in d1) d2.writable = d1.writable;",
    "if ('value' in d1) d2.value = d1.value;",
    "if ('get' in d1) d2.get = d1.get;",
    "if ('set' in d1) d2.set = d1.set;",
    "return defineProperty_(obj, prop, d2);",
  "};",
"})();",

"Object.defineProperty(Object, 'defineProperties',",
    "{configurable: true, writable: true, value:",
  "function(obj, props) {",
    "var keys = Object.keys(props);",
    "for (var i = 0; i < keys.length; i++) {",
      "Object.defineProperty(obj, keys[i], props[keys[i]]);",
    "}",
    "return obj;",
  "}",
"});",
"");

  wrapper = function(obj, prop) {
    if (!obj || !obj.isObject) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
          'Object.getOwnPropertyDescriptor called on non-object');
    }
    prop = String(prop);
    if (!(prop in obj.properties)) {
      return undefined;
    }
    var descriptor = Object.getOwnPropertyDescriptor(obj.properties, prop);
    var getter = obj.getter[prop];
    var setter = obj.setter[prop];

    if (getter || setter) {
      descriptor.get = getter;
      descriptor.set = setter;
      delete descriptor.value;
      delete descriptor.writable;
    }
    var pseudoDescriptor = thisInterpreter.nativeToPseudo(descriptor);
    if ('value' in descriptor) {
      thisInterpreter.setProperty(pseudoDescriptor, 'value', descriptor.value);
    }
    return pseudoDescriptor;
  };
  this.setProperty(this.OBJECT, 'getOwnPropertyDescriptor',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  wrapper = function(obj) {
    throwIfNullUndefined(obj);
    return thisInterpreter.getPrototype(obj);
  };
  this.setProperty(this.OBJECT, 'getPrototypeOf',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  wrapper = function(obj) {
    return Boolean(obj) && !obj.preventExtensions;
  };
  this.setProperty(this.OBJECT, 'isExtensible',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  wrapper = function(obj) {
    if (obj && obj.isObject) {
      obj.preventExtensions = true;
    }
    return obj;
  };
  this.setProperty(this.OBJECT, 'preventExtensions',
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  // Instance methods on Object.
  this.setNativeFunctionPrototype(this.OBJECT, 'toString',
      Interpreter.Object.prototype.toString);
  this.setNativeFunctionPrototype(this.OBJECT, 'toLocaleString',
      Interpreter.Object.prototype.toString);
  this.setNativeFunctionPrototype(this.OBJECT, 'valueOf',
      Interpreter.Object.prototype.valueOf);

  wrapper = function(prop) {
    throwIfNullUndefined(this);
    if (!this.isObject) {
      return this.hasOwnProperty(prop);
    }
    return String(prop) in this.properties;
  };
  this.setNativeFunctionPrototype(this.OBJECT, 'hasOwnProperty', wrapper);

  wrapper = function(prop) {
    throwIfNullUndefined(this);
    return Object.prototype.propertyIsEnumerable.call(this.properties, prop);
  };
  this.setNativeFunctionPrototype(this.OBJECT, 'propertyIsEnumerable', wrapper);

  wrapper = function(obj) {
    while (true) {
      // Note, circular loops shouldn't be possible.
      obj = thisInterpreter.getPrototype(obj);
      if (!obj) {
        // No parent; reached the top.
        return false;
      }
      if (obj === this) {
        return true;
      }
    }
  };
  this.setNativeFunctionPrototype(this.OBJECT, 'isPrototypeOf',  wrapper);
};

/**
 * Initialize the Array class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initArray = function(scope) {
  var thisInterpreter = this;
  var getInt = function(obj, def) {
    // Return an integer, or the default.
    var n = obj ? Math.floor(obj) : def;
    if (isNaN(n)) {
      n = def;
    }
    return n;
  };
  var wrapper;
  // Array constructor.
  wrapper = function(var_args) {
    if (thisInterpreter.calledWithNew()) {
      // Called as new Array().
      var newArray = this;
    } else {
      // Called as Array().
      var newArray =
          thisInterpreter.createObjectProto(thisInterpreter.ARRAY_PROTO);
    }
    var first = arguments[0];
    if (arguments.length === 1 && typeof first === 'number') {
      if (isNaN(Interpreter.legalArrayLength(first))) {
        thisInterpreter.throwException(thisInterpreter.RANGE_ERROR,
                                       'Invalid array length');
      }
      newArray.properties.length = first;
    } else {
      for (var i = 0; i < arguments.length; i++) {
        newArray.properties[i] = arguments[i];
      }
      newArray.properties.length = i;
    }
    return newArray;
  };
  this.ARRAY = this.createNativeFunction(wrapper, true);
  this.ARRAY_PROTO = this.ARRAY.properties['prototype'];
  this.setProperty(scope, 'Array', this.ARRAY);

  // Static methods on Array.
  wrapper = function(obj) {
    return obj && obj.class === 'Array';
  };
  this.setProperty(this.ARRAY, 'isArray',
                   this.createNativeFunction(wrapper, false),
                   Interpreter.NONENUMERABLE_DESCRIPTOR);

  // Instance methods on Array.
  wrapper = function() {
    return Array.prototype.pop.call(this.properties);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'pop', wrapper);

  wrapper = function(var_args) {
    return Array.prototype.push.apply(this.properties, arguments);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'push', wrapper);

  wrapper = function() {
    return Array.prototype.shift.call(this.properties);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'shift', wrapper);

  wrapper = function(var_args) {
    return Array.prototype.unshift.apply(this.properties, arguments);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'unshift', wrapper);

  wrapper = function() {
    Array.prototype.reverse.call(this.properties);
    return this;
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'reverse', wrapper);

  wrapper = function(index, howmany /*, var_args*/) {
    var list = Array.prototype.splice.apply(this.properties, arguments);
    return thisInterpreter.nativeToPseudo(list);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'splice', wrapper);

  wrapper = function(opt_begin, opt_end) {
    var list = Array.prototype.slice.call(this.properties, opt_begin, opt_end);
    return thisInterpreter.nativeToPseudo(list);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'slice', wrapper);

  wrapper = function(opt_separator) {
    return Array.prototype.join.call(this.properties, opt_separator);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'join', wrapper);

  wrapper = function(var_args) {
    var list = [];
    var length = 0;
    // Start by copying the current array.
    var iLength = thisInterpreter.getProperty(this, 'length');
    for (var i = 0; i < iLength; i++) {
      if (thisInterpreter.hasProperty(this, i)) {
        var element = thisInterpreter.getProperty(this, i);
        list[length] = element;
      }
      length++;
    }
    // Loop through all arguments and copy them in.
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (thisInterpreter.isa(value, thisInterpreter.ARRAY)) {
        var jLength = thisInterpreter.getProperty(value, 'length');
        for (var j = 0; j < jLength; j++) {
          if (thisInterpreter.hasProperty(value, j)) {
            list[length] = thisInterpreter.getProperty(value, j);
          }
          length++;
        }
      } else {
        list[length] = value;
      }
    }
    return thisInterpreter.nativeToPseudo(list);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'concat', wrapper);

  wrapper = function(searchElement, opt_fromIndex) {
    return Array.prototype.indexOf.apply(this.properties, arguments);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'indexOf', wrapper);

  wrapper = function(searchElement, opt_fromIndex) {
    return Array.prototype.lastIndexOf.apply(this.properties, arguments);
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'lastIndexOf', wrapper);

  wrapper = function() {
    Array.prototype.sort.call(this.properties);
    return this;
  };
  this.setNativeFunctionPrototype(this.ARRAY, 'sort', wrapper);

  this.polyfills_.push(
// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/every
"Object.defineProperty(Array.prototype, 'every',",
    "{configurable: true, writable: true, value:",
  "function(callbackfn, thisArg) {",
    "if (!this || typeof callbackfn !== 'function') throw TypeError();",
    "var T, k;",
    "var O = Object(this);",
    "var len = O.length >>> 0;",
    "if (arguments.length > 1) T = thisArg;",
    "k = 0;",
    "while (k < len) {",
      "if (k in O && !callbackfn.call(T, O[k], k, O)) return false;",
      "k++;",
    "}",
    "return true;",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
"Object.defineProperty(Array.prototype, 'filter',",
    "{configurable: true, writable: true, value:",
  "function(fun/*, thisArg*/) {",
    "if (this === void 0 || this === null || typeof fun !== 'function') throw TypeError();",
    "var t = Object(this);",
    "var len = t.length >>> 0;",
    "var res = [];",
    "var thisArg = arguments.length >= 2 ? arguments[1] : void 0;",
    "for (var i = 0; i < len; i++) {",
      "if (i in t) {",
        "var val = t[i];",
        "if (fun.call(thisArg, val, i, t)) res.push(val);",
      "}",
    "}",
    "return res;",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
"Object.defineProperty(Array.prototype, 'forEach',",
    "{configurable: true, writable: true, value:",
  "function(callback, thisArg) {",
    "if (!this || typeof callback !== 'function') throw TypeError();",
    "var T, k;",
    "var O = Object(this);",
    "var len = O.length >>> 0;",
    "if (arguments.length > 1) T = thisArg;",
    "k = 0;",
    "while (k < len) {",
      "if (k in O) callback.call(T, O[k], k, O);",
      "k++;",
    "}",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map
"Object.defineProperty(Array.prototype, 'map',",
    "{configurable: true, writable: true, value:",
  "function(callback, thisArg) {",
    "if (!this || typeof callback !== 'function') new TypeError;",
    "var T, A, k;",
    "var O = Object(this);",
    "var len = O.length >>> 0;",
    "if (arguments.length > 1) T = thisArg;",
    "A = new Array(len);",
    "k = 0;",
    "while (k < len) {",
      "if (k in O) A[k] = callback.call(T, O[k], k, O);",
      "k++;",
    "}",
    "return A;",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/Reduce
"Object.defineProperty(Array.prototype, 'reduce',",
    "{configurable: true, writable: true, value:",
  "function(callback /*, initialValue*/) {",
    "if (!this || typeof callback !== 'function') throw TypeError();",
    "var t = Object(this), len = t.length >>> 0, k = 0, value;",
    "if (arguments.length === 2) {",
      "value = arguments[1];",
    "} else {",
      "while (k < len && !(k in t)) k++;",
      "if (k >= len) {",
        "throw TypeError('Reduce of empty array with no initial value');",
      "}",
      "value = t[k++];",
    "}",
    "for (; k < len; k++) {",
      "if (k in t) value = callback(value, t[k], k, t);",
    "}",
    "return value;",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/ReduceRight
"Object.defineProperty(Array.prototype, 'reduceRight',",
    "{configurable: true, writable: true, value:",
  "function(callback /*, initialValue*/) {",
    "if (null === this || 'undefined' === typeof this || 'function' !== typeof callback) throw TypeError();",
    "var t = Object(this), len = t.length >>> 0, k = len - 1, value;",
    "if (arguments.length >= 2) {",
      "value = arguments[1];",
    "} else {",
      "while (k >= 0 && !(k in t)) k--;",
      "if (k < 0) {",
        "throw TypeError('Reduce of empty array with no initial value');",
      "}",
      "value = t[k--];",
    "}",
    "for (; k >= 0; k--) {",
      "if (k in t) value = callback(value, t[k], k, t);",
    "}",
    "return value;",
  "}",
"});",

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/some
"Object.defineProperty(Array.prototype, 'some',",
    "{configurable: true, writable: true, value:",
  "function(fun/*, thisArg*/) {",
    "if (!this || typeof fun !== 'function') throw TypeError();",
    "var t = Object(this);",
    "var len = t.length >>> 0;",
    "var thisArg = arguments.length >= 2 ? arguments[1] : void 0;",
    "for (var i = 0; i < len; i++) {",
      "if (i in t && fun.call(thisArg, t[i], i, t)) {",
        "return true;",
      "}",
    "}",
    "return false;",
  "}",
"});",


"(function() {",
  "var sort_ = Array.prototype.sort;",
  "Array.prototype.sort = function(opt_comp) {",
    // Fast native sort.
    "if (typeof opt_comp !== 'function') {",
      "return sort_.call(this);",
    "}",
    // Slow bubble sort.
    "for (var i = 0; i < this.length; i++) {",
      "var changes = 0;",
      "for (var j = 0; j < this.length - i - 1; j++) {",
        "if (opt_comp(this[j], this[j + 1]) > 0) {",
          "var swap = this[j];",
          "this[j] = this[j + 1];",
          "this[j + 1] = swap;",
          "changes++;",
        "}",
      "}",
      "if (!changes) break;",
    "}",
    "return this;",
  "};",
"})();",

"Object.defineProperty(Array.prototype, 'toLocaleString',",
    "{configurable: true, writable: true, value:",
  "function() {",
    "var out = [];",
    "for (var i = 0; i < this.length; i++) {",
      "out[i] = (this[i] === null || this[i] === undefined) ? '' : this[i].toLocaleString();",
    "}",
    "return out.join(',');",
  "}",
"});",
"");
};

/**
 * Initialize the String class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initString = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // String constructor.
  wrapper = function(value) {
    value = String(value);
    if (thisInterpreter.calledWithNew()) {
      // Called as new String().
      this.data = value;
      return this;
    } else {
      // Called as String().
      return value;
    }
  };
  this.STRING = this.createNativeFunction(wrapper, true);
  this.setProperty(scope, 'String', this.STRING);

  // Static methods on String.
  this.setProperty(this.STRING, 'fromCharCode',
      this.createNativeFunction(String.fromCharCode, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  // Instance methods on String.
  // Methods with exclusively primitive arguments.
  var functions = ['trim', 'toLowerCase', 'toUpperCase',
      'toLocaleLowerCase', 'toLocaleUpperCase', 'charAt', 'charCodeAt',
      'substring', 'slice', 'substr', 'indexOf', 'lastIndexOf', 'concat'];
  for (var i = 0; i < functions.length; i++) {
    this.setNativeFunctionPrototype(this.STRING, functions[i],
                                    String.prototype[functions[i]]);
  }

  wrapper = function(compareString, locales, options) {
    locales = locales ? thisInterpreter.pseudoToNative(locales) : undefined;
    options = options ? thisInterpreter.pseudoToNative(options) : undefined;
    return String(this).localeCompare(compareString, locales, options);
  };
  this.setNativeFunctionPrototype(this.STRING, 'localeCompare', wrapper);

  wrapper = function(separator, limit) {
    if (thisInterpreter.isa(separator, thisInterpreter.REGEXP)) {
      separator = separator.data;
    }
    var jsList = String(this).split(separator, limit);
    return thisInterpreter.nativeToPseudo(jsList);
  };
  this.setNativeFunctionPrototype(this.STRING, 'split', wrapper);

  wrapper = function(regexp) {
    regexp = regexp ? regexp.data : undefined;
    var match = String(this).match(regexp);
    if (!match) {
      return null;
    }
    return thisInterpreter.nativeToPseudo(match);
  };
  this.setNativeFunctionPrototype(this.STRING, 'match', wrapper);

  wrapper = function(regexp) {
    regexp = regexp ? regexp.data : undefined;
    return String(this).search(regexp);
  };
  this.setNativeFunctionPrototype(this.STRING, 'search', wrapper);

  wrapper = function(substr, newSubstr) {
    // Support for function replacements is the responsibility of a polyfill.
    return String(this).replace(substr.data || substr, newSubstr);
  };
  this.setNativeFunctionPrototype(this.STRING, 'replace', wrapper);
  // Add a polyfill to handle replace's second argument being a function.
  this.polyfills_.push(
"(function() {",
  "var replace_ = String.prototype.replace;",
  "String.prototype.replace = function(substr, newSubstr) {",
    "if (typeof newSubstr !== 'function') {",
      // string.replace(string|regexp, string)
      "return replace_.call(this, substr, newSubstr);",
    "}",
    "var str = this;",
    "if (substr instanceof RegExp) {",  // string.replace(regexp, function)
      "var subs = [];",
      "var m = substr.exec(str);",
      "while (m) {",
        "m.push(m.index, str);",
        "var inject = newSubstr.apply(null, m);",
        "subs.push([m.index, m[0].length, inject]);",
        "m = substr.global ? substr.exec(str) : null;",
      "}",
      "for (var i = subs.length - 1; i >= 0; i--) {",
        "str = str.substring(0, subs[i][0]) + subs[i][2] + " +
            "str.substring(subs[i][0] + subs[i][1]);",
      "}",
    "} else {",                         // string.replace(string, function)
      "var i = str.indexOf(substr);",
      "if (i !== -1) {",
        "var inject = newSubstr(str.substr(i, substr.length), i, str);",
        "str = str.substring(0, i) + inject + " +
            "str.substring(i + substr.length);",
      "}",
    "}",
    "return str;",
  "};",
"})();",
"");
};

/**
 * Initialize the Boolean class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initBoolean = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // Boolean constructor.
  wrapper = function(value) {
    value = Boolean(value);
    if (thisInterpreter.calledWithNew()) {
      // Called as new Boolean().
      this.data = value;
      return this;
    } else {
      // Called as Boolean().
      return value;
    }
  };
  this.BOOLEAN = this.createNativeFunction(wrapper, true);
  this.setProperty(scope, 'Boolean', this.BOOLEAN);
};

/**
 * Initialize the Number class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initNumber = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // Number constructor.
  wrapper = function(value) {
    value = Number(value);
    if (thisInterpreter.calledWithNew()) {
      // Called as new Number().
      this.data = value;
      return this;
    } else {
      // Called as Number().
      return value;
    }
  };
  this.NUMBER = this.createNativeFunction(wrapper, true);
  this.setProperty(scope, 'Number', this.NUMBER);

  var numConsts = ['MAX_VALUE', 'MIN_VALUE', 'NaN', 'NEGATIVE_INFINITY',
                   'POSITIVE_INFINITY'];
  for (var i = 0; i < numConsts.length; i++) {
    this.setProperty(this.NUMBER, numConsts[i], Number[numConsts[i]],
        Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  }

  // Instance methods on Number.
  wrapper = function(fractionDigits) {
    try {
      return Number(this).toExponential(fractionDigits);
    } catch (e) {
      // Throws if fractionDigits isn't within 0-20.
      thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
    }
  };
  this.setNativeFunctionPrototype(this.NUMBER, 'toExponential', wrapper);

  wrapper = function(digits) {
    try {
      return Number(this).toFixed(digits);
    } catch (e) {
      // Throws if digits isn't within 0-20.
      thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
    }
  };
  this.setNativeFunctionPrototype(this.NUMBER, 'toFixed', wrapper);

  wrapper = function(precision) {
    try {
      return Number(this).toPrecision(precision);
    } catch (e) {
      // Throws if precision isn't within range (depends on implementation).
      thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
    }
  };
  this.setNativeFunctionPrototype(this.NUMBER, 'toPrecision', wrapper);

  wrapper = function(radix) {
    try {
      return Number(this).toString(radix);
    } catch (e) {
      // Throws if radix isn't within 2-36.
      thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
    }
  };
  this.setNativeFunctionPrototype(this.NUMBER, 'toString', wrapper);

  wrapper = function(locales, options) {
    locales = locales ? thisInterpreter.pseudoToNative(locales) : undefined;
    options = options ? thisInterpreter.pseudoToNative(options) : undefined;
    return Number(this).toLocaleString(locales, options);
  };
  this.setNativeFunctionPrototype(this.NUMBER, 'toLocaleString', wrapper);
};

/**
 * Initialize the Date class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initDate = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // Date constructor.
  wrapper = function(value, var_args) {
    if (!thisInterpreter.calledWithNew()) {
      // Called as Date().
      // Calling Date() as a function returns a string, no arguments are heeded.
      return Date();
    }
    // Called as new Date().
    var args = [null].concat(Array.from(arguments));
    this.data = new (Function.prototype.bind.apply(Date, args));
    return this;
  };
  this.DATE = this.createNativeFunction(wrapper, true);
  this.setProperty(scope, 'Date', this.DATE);

  // Static methods on Date.
  this.setProperty(this.DATE, 'now', this.createNativeFunction(Date.now, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  this.setProperty(this.DATE, 'parse',
      this.createNativeFunction(Date.parse, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  this.setProperty(this.DATE, 'UTC', this.createNativeFunction(Date.UTC, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  // Instance methods on Date.
  var functions = ['getDate', 'getDay', 'getFullYear', 'getHours',
      'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds', 'getTime',
      'getTimezoneOffset', 'getUTCDate', 'getUTCDay', 'getUTCFullYear',
      'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth',
      'getUTCSeconds', 'getYear',
      'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
      'setMinutes', 'setMonth', 'setSeconds', 'setTime', 'setUTCDate',
      'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes',
      'setUTCMonth', 'setUTCSeconds', 'setYear',
      'toDateString', 'toISOString', 'toJSON', 'toGMTString',
      'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString',
      'toTimeString', 'toUTCString'];
  for (var i = 0; i < functions.length; i++) {
    wrapper = (function(nativeFunc) {
      return function(var_args) {
        var args = [];
        for (var i = 0; i < arguments.length; i++) {
          args[i] = thisInterpreter.pseudoToNative(arguments[i]);
        }
        return this.data[nativeFunc].apply(this.data, args);
      };
    })(functions[i]);
    this.setNativeFunctionPrototype(this.DATE, functions[i], wrapper);
  }
};

/**
 * Initialize Regular Expression object.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initRegExp = function(scope) {
  var thisInterpreter = this;
  var wrapper;
  // RegExp constructor.
  wrapper = function(pattern, flags) {
    if (thisInterpreter.calledWithNew()) {
      // Called as new RegExp().
      var rgx = this;
    } else {
      // Called as RegExp().
      var rgx = thisInterpreter.createObjectProto(thisInterpreter.REGEXP_PROTO);
    }
    pattern = pattern ? pattern.toString() : '';
    flags = flags ? flags.toString() : '';
    thisInterpreter.populateRegExp(rgx, new RegExp(pattern, flags));
    return rgx;
  };
  this.REGEXP = this.createNativeFunction(wrapper, true);
  this.REGEXP_PROTO = this.REGEXP.properties['prototype'];
  this.setProperty(scope, 'RegExp', this.REGEXP);

  this.setProperty(this.REGEXP.properties['prototype'], 'global', undefined,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(this.REGEXP.properties['prototype'], 'ignoreCase', undefined,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(this.REGEXP.properties['prototype'], 'multiline', undefined,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(this.REGEXP.properties['prototype'], 'source', '(?:)',
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);

  wrapper = function(str) {
    return this.data.test(str);
  };
  this.setNativeFunctionPrototype(this.REGEXP, 'test', wrapper);

  wrapper = function(str) {
    str = str.toString();
    // Get lastIndex from wrapped regex, since this is settable.
    this.data.lastIndex =
        Number(thisInterpreter.getProperty(this, 'lastIndex'));
    var match = this.data.exec(str);
    thisInterpreter.setProperty(this, 'lastIndex', this.data.lastIndex);

    if (match) {
      var result =
          thisInterpreter.createObjectProto(thisInterpreter.ARRAY_PROTO);
      for (var i = 0; i < match.length; i++) {
        thisInterpreter.setProperty(result, i, match[i]);
      }
      // match has additional properties.
      thisInterpreter.setProperty(result, 'index', match.index);
      thisInterpreter.setProperty(result, 'input', match.input);
      return result;
    }
    return null;
  };
  this.setNativeFunctionPrototype(this.REGEXP, 'exec', wrapper);
};

/**
 * Initialize the Error class.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initError = function(scope) {
  var thisInterpreter = this;
  // Error constructor.
  this.ERROR = this.createNativeFunction(function(opt_message) {
    if (thisInterpreter.calledWithNew()) {
      // Called as new Error().
      var newError = this;
    } else {
      // Called as Error().
      var newError = thisInterpreter.createObject(thisInterpreter.ERROR);
    }
    if (opt_message) {
      thisInterpreter.setProperty(newError, 'message', String(opt_message),
          Interpreter.NONENUMERABLE_DESCRIPTOR);
    }
    return newError;
  }, true);
  this.setProperty(scope, 'Error', this.ERROR);
  this.setProperty(this.ERROR.properties['prototype'], 'message', '',
      Interpreter.NONENUMERABLE_DESCRIPTOR);
  this.setProperty(this.ERROR.properties['prototype'], 'name', 'Error',
      Interpreter.NONENUMERABLE_DESCRIPTOR);

  var createErrorSubclass = function(name) {
    var constructor = thisInterpreter.createNativeFunction(
        function(opt_message) {
          if (thisInterpreter.calledWithNew()) {
            // Called as new XyzError().
            var newError = this;
          } else {
            // Called as XyzError().
            var newError = thisInterpreter.createObject(constructor);
          }
          if (opt_message) {
            thisInterpreter.setProperty(newError, 'message',
                String(opt_message), Interpreter.NONENUMERABLE_DESCRIPTOR);
          }
          return newError;
        }, true);
    thisInterpreter.setProperty(constructor, 'prototype',
        thisInterpreter.createObject(thisInterpreter.ERROR));
    thisInterpreter.setProperty(constructor.properties['prototype'], 'name',
        name, Interpreter.NONENUMERABLE_DESCRIPTOR);
    thisInterpreter.setProperty(scope, name, constructor);

    return constructor;
  };

  this.EVAL_ERROR = createErrorSubclass('EvalError');
  this.RANGE_ERROR = createErrorSubclass('RangeError');
  this.REFERENCE_ERROR = createErrorSubclass('ReferenceError');
  this.SYNTAX_ERROR = createErrorSubclass('SyntaxError');
  this.TYPE_ERROR = createErrorSubclass('TypeError');
  this.URI_ERROR = createErrorSubclass('URIError');
};

/**
 * Initialize Math object.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initMath = function(scope) {
  var thisInterpreter = this;
  var myMath = this.createObjectProto(this.OBJECT_PROTO);
  this.setProperty(scope, 'Math', myMath);
  var mathConsts = ['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI',
                    'SQRT1_2', 'SQRT2'];
  for (var i = 0; i < mathConsts.length; i++) {
    this.setProperty(myMath, mathConsts[i], Math[mathConsts[i]],
        Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  }
  var numFunctions = ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos',
                      'exp', 'floor', 'log', 'max', 'min', 'pow', 'random',
                      'round', 'sin', 'sqrt', 'tan'];
  for (var i = 0; i < numFunctions.length; i++) {
    this.setProperty(myMath, numFunctions[i],
        this.createNativeFunction(Math[numFunctions[i]], false),
        Interpreter.NONENUMERABLE_DESCRIPTOR);
  }
};

/**
 * Initialize JSON object.
 * @param {!Interpreter.Object} scope Global scope.
 */
Interpreter.prototype.initJSON = function(scope) {
  var thisInterpreter = this;
  var myJSON = thisInterpreter.createObjectProto(this.OBJECT_PROTO);
  this.setProperty(scope, 'JSON', myJSON);

  var wrapper = function(text) {
    try {
      var nativeObj = JSON.parse(text.toString());
    } catch (e) {
      thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR, e.message);
    }
    return thisInterpreter.nativeToPseudo(nativeObj);
  };
  this.setProperty(myJSON, 'parse', this.createNativeFunction(wrapper, false));

  wrapper = function(value) {
    var nativeObj = thisInterpreter.pseudoToNative(value);
    try {
      var str = JSON.stringify(nativeObj);
    } catch (e) {
      thisInterpreter.throwException(thisInterpreter.TYPE_ERROR, e.message);
    }
    return str;
  };
  this.setProperty(myJSON, 'stringify',
      this.createNativeFunction(wrapper, false));
};

/**
 * Is an object of a certain class?
 * @param {Interpreter.Value} child Object to check.
 * @param {Interpreter.Object} constructor Constructor of object.
 * @return {boolean} True if object is the class or inherits from it.
 *     False otherwise.
 */
Interpreter.prototype.isa = function(child, constructor) {
  if (child === null || child === undefined || !constructor) {
    return false;
  }
  var proto = constructor.properties['prototype'];
  if (child === proto) {
    return true;
  }
  // The first step up the prototype chain is harder since the child might be
  // a primitive value.  Subsequent steps can just follow the .proto property.
  child = this.getPrototype(child);
  while (child) {
    if (child === proto) {
      return true;
    }
    child = child.proto;
  }
  return false;
};

/**
 * Is a value a legal integer for an array length?
 * @param {Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
Interpreter.legalArrayLength = function(x) {
  var n = x >>> 0;
  // Array length must be between 0 and 2^32-1 (inclusive).
  return (n === Number(x)) ? n : NaN;
};

/**
 * Is a value a legal integer for an array index?
 * @param {Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
Interpreter.legalArrayIndex = function(x) {
  var n = x >>> 0;
  // Array index cannot be 2^32-1, otherwise length would be 2^32.
  // 0xffffffff is 2^32-1.
  return (String(n) === String(x) && n !== 0xffffffff) ? n : NaN;
};

/**
 * Typedef for JS values.
 * @typedef {!Interpreter.Object|boolean|number|string|undefined|null}
 */
Interpreter.Value;

/**
 * Class for an object.
 * @param {Interpreter.Object} proto Prototype object or null.
 * @constructor
 */
Interpreter.Object = function(proto) {
  this.getter = Object.create(null);
  this.setter = Object.create(null);
  this.properties = Object.create(null);
  this.proto = proto;
};

/** @type {Interpreter.Object} */
Interpreter.Object.prototype.proto = null;

/** @type {boolean} */
Interpreter.Object.prototype.isObject = true;

/** @type {string} */
Interpreter.Object.prototype.class = 'Object';

/** @type {Date|RegExp|boolean|number|string|undefined|null} */
Interpreter.Object.prototype.data = null;

/**
 * Convert this object into a string.
 * @return {string} String value.
 * @override
 */
Interpreter.Object.prototype.toString = function() {
  if (this.class === 'Array') {
    // Array
    var cycles = Interpreter.toStringCycles_;
    cycles.push(this);
    try {
      var strs = [];
      for (var i = 0; i < this.properties.length; i++) {
        var value = this.properties[i];
        strs[i] = (value && value.isObject && cycles.indexOf(value) !== -1) ?
            '...' : value;
      }
    } finally {
      cycles.pop();
    }
    return strs.join(',');
  }
  if (this.class === 'Error') {
    var cycles = Interpreter.toStringCycles_;
    if (cycles.indexOf(this) !== -1) {
      return '[object Error]';
    }
    var name, message;
    // Bug: Does not support getters and setters for name or message.
    var obj = this;
    do {
      if ('name' in obj.properties) {
        name = obj.properties['name'];
        break;
      }
    } while ((obj = obj.proto));
    var obj = this;
    do {
      if ('message' in obj.properties) {
        message = obj.properties['message'];
        break;
      }
    } while ((obj = obj.proto));
    cycles.push(this);
    try {
      name = name && name.toString();
      message = message && message.toString();
    } finally {
      cycles.pop();
    }
    return message ? name + ': ' + message : String(name);
  }

  // RegExp, Date, and boxed primitives.
  if (this.data !== null) {
    return String(this.data);
  }

  return '[object ' + this.class + ']';
};

/**
 * Return the object's value.
 * @return {Interpreter.Value} Value.
 * @override
 */
Interpreter.Object.prototype.valueOf = function() {
  if (this.data === undefined || this.data === null ||
      this.data instanceof RegExp) {
    return this; // An Object.
  }
  if (this.data instanceof Date) {
    return this.data.valueOf();  // Milliseconds.
  }
  return /** @type {(boolean|number|string)} */ (this.data);  // Boxed primitive.
};

/**
 * Create a new data object based on a constructor's prototype.
 * @param {Interpreter.Object} constructor Parent constructor function,
 *     or null if scope object.
 * @return {!Interpreter.Object} New data object.
 */
Interpreter.prototype.createObject = function(constructor) {
  return this.createObjectProto(constructor &&
                                constructor.properties['prototype']);
};

/**
 * Create a new data object based on a prototype.
 * @param {Interpreter.Object} proto Prototype object.
 * @return {!Interpreter.Object} New data object.
 */
Interpreter.prototype.createObjectProto = function(proto) {
  var obj = new Interpreter.Object(proto);
  // Functions have prototype objects.
  if (this.isa(obj, this.FUNCTION)) {
    this.setProperty(obj, 'prototype',
                     this.createObjectProto(this.OBJECT_PROTO || null));
    obj.class = 'Function';
  }
  // Arrays have length.
  if (this.isa(obj, this.ARRAY)) {
    this.setProperty(obj, 'length', 0,
        {configurable: false, enumerable: false, writable: true});
    obj.class = 'Array';
  }
  if (this.isa(obj, this.ERROR)) {
    obj.class = 'Error';
  }
  return obj;
};

/**
 * Initialize a pseudo regular expression object based on a native regular
 * expression object.
 * @param {!Interpreter.Object} pseudoRegexp The existing object to set.
 * @param {!RegExp} nativeRegexp The native regular expression.
 */
Interpreter.prototype.populateRegExp = function(pseudoRegexp, nativeRegexp) {
  pseudoRegexp.data = nativeRegexp;
  // lastIndex is settable, all others are read-only attributes
  this.setProperty(pseudoRegexp, 'lastIndex', nativeRegexp.lastIndex,
      Interpreter.NONENUMERABLE_DESCRIPTOR);
  this.setProperty(pseudoRegexp, 'source', nativeRegexp.source,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(pseudoRegexp, 'global', nativeRegexp.global,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(pseudoRegexp, 'ignoreCase', nativeRegexp.ignoreCase,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
  this.setProperty(pseudoRegexp, 'multiline', nativeRegexp.multiline,
      Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
};

/**
 * Create a new function.
 * @param {!Object} node AST node defining the function.
 * @param {!Object} scope Parent scope.
 * @return {!Interpreter.Object} New function.
 */
Interpreter.prototype.createFunction = function(node, scope) {
  var func = this.createObjectProto(this.FUNCTION_PROTO);
  func.parentScope = scope;
  func.node = node;
  this.setProperty(func, 'length', func.node['params'].length,
      Interpreter.READONLY_DESCRIPTOR);
  return func;
};

/**
 * Create a new native function.
 * @param {!Function} nativeFunc JavaScript function.
 * @param {boolean=} opt_constructor If true, the function's
 * prototype will have its constructor property set to the function.
 * If false, the function cannot be called as a constructor (e.g. escape).
 * Defaults to undefined.
 * @return {!Interpreter.Object} New function.
 */
Interpreter.prototype.createNativeFunction =
    function(nativeFunc, opt_constructor) {
  var func = this.createObjectProto(this.FUNCTION_PROTO);
  func.nativeFunc = nativeFunc;
  nativeFunc.id = this.functionCounter_++;
  this.setProperty(func, 'length', nativeFunc.length,
      Interpreter.READONLY_DESCRIPTOR);
  if (opt_constructor) {
    this.setProperty(func.properties['prototype'], 'constructor',
        func, Interpreter.NONENUMERABLE_DESCRIPTOR);
  } else if (opt_constructor === false) {
    func.illegalConstructor = true;
    this.setProperty(func, 'prototype', undefined);
  }
  return func;
};

/**
 * Create a new native asynchronous function.
 * @param {!Function} asyncFunc JavaScript function.
 * @return {!Interpreter.Object} New function.
 */
Interpreter.prototype.createAsyncFunction = function(asyncFunc) {
  var func = this.createObjectProto(this.FUNCTION_PROTO);
  func.asyncFunc = asyncFunc;
  asyncFunc.id = this.functionCounter_++;
  this.setProperty(func, 'length', asyncFunc.length,
      Interpreter.READONLY_DESCRIPTOR);
  return func;
};

/**
 * Converts from a native JS object or value to a JS interpreter object.
 * Can handle JSON-style values.
 * @param {*} nativeObj The native JS object to be converted.
 * @return {Interpreter.Value} The equivalent JS interpreter object.
 */
Interpreter.prototype.nativeToPseudo = function(nativeObj) {
  if (typeof nativeObj === 'boolean' ||
      typeof nativeObj === 'number' ||
      typeof nativeObj === 'string' ||
      nativeObj === null || nativeObj === undefined) {
    return nativeObj;
  }

  if (nativeObj instanceof RegExp) {
    var pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
    this.populateRegExp(pseudoRegexp, nativeObj);
    return pseudoRegexp;
  }

  if (nativeObj instanceof Function) {
    var interpreter = this;
    var wrapper = function() {
      return interpreter.nativeToPseudo(
        nativeObj.apply(interpreter,
          Array.prototype.slice.call(arguments)
          .map(function(i) {
            return interpreter.pseudoToNative(i);
          })
        )
      );
    };
    return this.createNativeFunction(wrapper, undefined);
  }

  var pseudoObj;
  if (Array.isArray(nativeObj)) {  // Array.
    pseudoObj = this.createObjectProto(this.ARRAY_PROTO);
    for (var i = 0; i < nativeObj.length; i++) {
      if (i in nativeObj) {
        this.setProperty(pseudoObj, i, this.nativeToPseudo(nativeObj[i]));
      }
    }
  } else {  // Object.
    pseudoObj = this.createObjectProto(this.OBJECT_PROTO);
    for (var key in nativeObj) {
      this.setProperty(pseudoObj, key, this.nativeToPseudo(nativeObj[key]));
    }
  }
  return pseudoObj;
};

/**
 * Converts from a JS interpreter object to native JS object.
 * Can handle JSON-style values, plus cycles.
 * @param {Interpreter.Value} pseudoObj The JS interpreter object to be
 * converted.
 * @param {Object=} opt_cycles Cycle detection (used in recursive calls).
 * @return {*} The equivalent native JS object or value.
 */
Interpreter.prototype.pseudoToNative = function(pseudoObj, opt_cycles) {
  if (typeof pseudoObj === 'boolean' ||
      typeof pseudoObj === 'number' ||
      typeof pseudoObj === 'string' ||
      pseudoObj === null || pseudoObj === undefined) {
    return pseudoObj;
  }

  if (this.isa(pseudoObj, this.REGEXP)) {  // Regular expression.
    return pseudoObj.data;
  }

  var cycles = opt_cycles || {
    pseudo: [],
    native: []
  };
  var i = cycles.pseudo.indexOf(pseudoObj);
  if (i !== -1) {
    return cycles.native[i];
  }
  cycles.pseudo.push(pseudoObj);
  var nativeObj;
  if (this.isa(pseudoObj, this.ARRAY)) {  // Array.
    nativeObj = [];
    cycles.native.push(nativeObj);
    var length = this.getProperty(pseudoObj, 'length');
    for (var i = 0; i < length; i++) {
      if (this.hasProperty(pseudoObj, i)) {
        nativeObj[i] =
            this.pseudoToNative(this.getProperty(pseudoObj, i), cycles);
      }
    }
  } else {  // Object.
    nativeObj = {};
    cycles.native.push(nativeObj);
    var val;
    for (var key in pseudoObj.properties) {
      val = pseudoObj.properties[key];
      nativeObj[key] = this.pseudoToNative(val, cycles);
    }
  }
  cycles.pseudo.pop();
  cycles.native.pop();
  return nativeObj;
};

/**
 * Look up the prototype for this value.
 * @param {Interpreter.Value} value Data object.
 * @return {Interpreter.Object} Prototype object, null if none.
 */
Interpreter.prototype.getPrototype = function(value) {
  switch (typeof value) {
    case 'number':
      return this.NUMBER.properties['prototype'];
    case 'boolean':
      return this.BOOLEAN.properties['prototype'];
    case 'string':
      return this.STRING.properties['prototype'];
  }
  if (value) {
    return value.proto;
  }
  return null;
};

/**
 * Fetch a property value from a data object.
 * @param {Interpreter.Value} obj Data object.
 * @param {Interpreter.Value} name Name of property.
 * @return {Interpreter.Value} Property value (may be undefined).
 */
Interpreter.prototype.getProperty = function(obj, name) {
  name = String(name);
  if (obj === undefined || obj === null) {
    this.throwException(this.TYPE_ERROR,
                        "Kann Eigenschaft nicht lesen von '" + name + "' aus " + obj);
  }
  if (name === 'length') {
    // Special cases for magic length property.
    if (this.isa(obj, this.STRING)) {
      return String(obj).length;
    }
  } else if (name.charCodeAt(0) < 0x40) {
    // Might have numbers in there?
    // Special cases for string array indexing
    if (this.isa(obj, this.STRING)) {
      var n = Interpreter.legalArrayIndex(name);
      if (!isNaN(n) && n < String(obj).length) {
        return String(obj)[n];
      }
    }
  }
  do {
    if (obj.properties && name in obj.properties) {
      var getter = obj.getter[name];
      if (getter) {
        // Flag this function as being a getter and thus needing immediate
        // execution (rather than being the value of the property).
        getter.isGetter = true;
        return getter;
      }
      return obj.properties[name];
    }
  } while ((obj = this.getPrototype(obj)));
  return undefined;
};

/**
 * Does the named property exist on a data object.
 * @param {Interpreter.Value} obj Data object.
 * @param {Interpreter.Value} name Name of property.
 * @return {boolean} True if property exists.
 */
Interpreter.prototype.hasProperty = function(obj, name) {
  if (!obj.isObject) {
    throw TypeError('Primitive data type has no properties');
  }
  name = String(name);
  if (name === 'length' && this.isa(obj, this.STRING)) {
    return true;
  }
  if (this.isa(obj, this.STRING)) {
    var n = Interpreter.legalArrayIndex(name);
    if (!isNaN(n) && n < String(obj).length) {
      return true;
    }
  }
  do {
    if (obj.properties && name in obj.properties) {
      return true;
    }
  } while ((obj = this.getPrototype(obj)));
  return false;
};

/**
 * Set a property value on a data object.
 * @param {!Interpreter.Object} obj Data object.
 * @param {Interpreter.Value} name Name of property.
 * @param {Interpreter.Value|ReferenceError} value New property value.
 *   Use ReferenceError if value is handled by descriptor instead.
 * @param {Object=} opt_descriptor Optional descriptor object.
 * @return {!Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
Interpreter.prototype.setProperty = function(obj, name, value, opt_descriptor) {
  name = String(name);
  if (obj === undefined || obj === null) {
    this.throwException(this.TYPE_ERROR,
                        "Kann Eigenschaft nicht setzen von '" + name + "' aus " + obj);
  }
  if (opt_descriptor && ('get' in opt_descriptor || 'set' in opt_descriptor) &&
      ('value' in opt_descriptor || 'writable' in opt_descriptor)) {
    this.throwException(this.TYPE_ERROR, 'Invalid property descriptor. ' +
        'Cannot both specify accessors and a value or writable attribute');
  }
  var strict = !this.stateStack || this.getScope().strict;
  if (!obj.isObject) {
    if (strict) {
      this.throwException(this.TYPE_ERROR, "Can't create property '" + name +
                          "' on '" + obj + "'");
    }
    return;
  }
  if (this.isa(obj, this.STRING)) {
    var n = Interpreter.legalArrayIndex(name);
    if (name === 'length' || (!isNaN(n) && n < String(obj).length)) {
      // Can't set length or letters on String objects.
      if (strict) {
        this.throwException(this.TYPE_ERROR, "Cannot assign to read only " +
            "property '" + name + "' of String '" + obj.data + "'");
      }
      return;
    }
  }
  if (obj.class === 'Array') {
    // Arrays have a magic length variable that is bound to the elements.
    var length = obj.properties.length;
    var i;
    if (name === 'length') {
      // Delete elements if length is smaller.
      var value = Interpreter.legalArrayLength(value);
      if (isNaN(value)) {
        this.throwException(this.RANGE_ERROR, 'Invalid array length');
      }
      if (value < length) {
        for (i in obj.properties) {
          i = Interpreter.legalArrayIndex(i);
          if (!isNaN(i) && value <= i) {
            delete obj.properties[i];
          }
        }
      }
    } else if (!isNaN(i = Interpreter.legalArrayIndex(name))) {
      // Increase length if this index is larger.
      obj.properties.length = Math.max(length, i + 1);
    }
  }
  if (obj.preventExtensions && !(name in obj.properties)) {
    if (strict) {
      this.throwException(this.TYPE_ERROR, "Can't add property '" + name +
                          "', object is not extensible");
    }
    return;
  }
  if (opt_descriptor) {
    // Define the property.
    if ('get' in opt_descriptor) {
      if (opt_descriptor.get) {
        obj.getter[name] = opt_descriptor.get;
      } else {
        delete obj.getter[name];
      }
    }
    if ('set' in opt_descriptor) {
      if (opt_descriptor.set) {
        obj.setter[name] = opt_descriptor.set;
      } else {
        delete obj.setter[name];
      }
    }
    var descriptor = {};
    if ('configurable' in opt_descriptor) {
      descriptor.configurable = opt_descriptor.configurable;
    }
    if ('enumerable' in opt_descriptor) {
      descriptor.enumerable = opt_descriptor.enumerable;
    }
    if ('writable' in opt_descriptor) {
      descriptor.writable = opt_descriptor.writable;
      delete obj.getter[name];
      delete obj.setter[name];
    }
    if ('value' in opt_descriptor) {
      descriptor.value = opt_descriptor.value;
      delete obj.getter[name];
      delete obj.setter[name];
    } else if (value !== ReferenceError) {
      descriptor.value = value;
      delete obj.getter[name];
      delete obj.setter[name];
    }
    try {
      Object.defineProperty(obj.properties, name, descriptor);
    } catch (e) {
      this.throwException(this.TYPE_ERROR, 'Cannot redefine property: ' + name);
    }
  } else {
    // Set the property.
    if (value === ReferenceError) {
      throw ReferenceError('Value not specified.');
    }
    // Determine the parent (possibly self) where the property is defined.
    var defObj = obj;
    while (!(name in defObj.properties)) {
      defObj = this.getPrototype(defObj);
      if (!defObj) {
        // This is a new property.
        defObj = obj;
        break;
      }
    }
    if (defObj.setter && defObj.setter[name]) {
      return defObj.setter[name];
    }
    if (defObj.getter && defObj.getter[name]) {
      if (strict) {
        this.throwException(this.TYPE_ERROR, "Cannot set property '" + name +
            "' of object '" + obj + "' which only has a getter");
      }
    } else {
      // No setter, simple assignment.
      try {
        obj.properties[name] = value;
      } catch (e) {
        if (strict) {
          this.throwException(this.TYPE_ERROR, "Cannot assign to read only " +
              "property '" + name + "' of object '" + obj + "'");
        }
      }
    }
  }
};

/**
 * Convenience method for adding a native function as a non-enumerable property
 * onto an object's prototype.
 * @param {!Interpreter.Object} obj Data object.
 * @param {Interpreter.Value} name Name of property.
 * @param {!Function} wrapper Function object.
 */
Interpreter.prototype.setNativeFunctionPrototype =
    function(obj, name, wrapper) {
  this.setProperty(obj.properties['prototype'], name,
      this.createNativeFunction(wrapper, false),
      Interpreter.NONENUMERABLE_DESCRIPTOR);
};

/**
 * Returns the current scope from the stateStack.
 * @return {!Interpreter.Object} Current scope dictionary.
 */
Interpreter.prototype.getScope = function() {
  var scope = this.stateStack[this.stateStack.length - 1].scope;
  if (!scope) {
    throw Error('No scope found.');
  }
  return scope;
};

/**
 * Create a new scope dictionary.
 * @param {!Object} node AST node defining the scope container
 *     (e.g. a function).
 * @param {Interpreter.Object} parentScope Scope to link to.
 * @return {!Interpreter.Object} New scope.
 */
Interpreter.prototype.createScope = function(node, parentScope) {
  var scope = this.createObjectProto(null);
  scope.parentScope = parentScope;
  if (!parentScope) {
    this.initGlobalScope(scope);
  }
  this.populateScope_(node, scope);

  // Determine if this scope starts with 'use strict'.
  scope.strict = false;
  if (parentScope && parentScope.strict) {
    scope.strict = true;
  } else {
    var firstNode = node['body'] && node['body'][0];
    if (firstNode && firstNode.expression &&
        firstNode.expression['type'] === 'Literal' &&
        firstNode.expression.value === 'use strict') {
      scope.strict = true;
    }
  }
  return scope;
};

/**
 * Create a new special scope dictionary. Similar to createScope(), but
 * doesn't assume that the scope is for a function body.
 * This is used for 'catch' clauses and 'with' statements.
 * @param {!Interpreter.Object} parentScope Scope to link to.
 * @param {Interpreter.Object=} opt_scope Optional object to transform into
 *     scope.
 * @return {!Interpreter.Object} New scope.
 */
Interpreter.prototype.createSpecialScope = function(parentScope, opt_scope) {
  if (!parentScope) {
    throw Error('parentScope required');
  }
  var scope = opt_scope || this.createObjectProto(null);
  scope.parentScope = parentScope;
  scope.strict = parentScope.strict;
  return scope;
};

/**
 * Retrieves a value from the scope chain.
 * @param {string} name Name of variable.
 * @return {Interpreter.Value} Any value.
 *   May be flagged as being a getter and thus needing immediate execution
 *   (rather than being the value of the property).
 */
Interpreter.prototype.getValueFromScope = function(name) {
  var scope = this.getScope();
  while (scope && scope !== this.global) {
    if (name in scope.properties) {
      return scope.properties[name];
    }
    scope = scope.parentScope;
  }
  // The root scope is also an object which has inherited properties and
  // could also have getters.
  if (scope === this.global && this.hasProperty(scope, name)) {
    return this.getProperty(scope, name);
  }
  // Typeof operator is unique: it can safely look at non-defined variables.
  var prevNode = this.stateStack[this.stateStack.length - 1].node;
  if (prevNode['type'] === 'UnaryExpression' &&
      prevNode['operator'] === 'typeof') {
    return undefined;
  }
  this.throwException(this.REFERENCE_ERROR, name + ' ist nicht definiert');
};

/**
 * Sets a value to the current scope.
 * @param {string} name Name of variable.
 * @param {Interpreter.Value} value Value.
 * @return {!Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
Interpreter.prototype.setValueToScope = function(name, value) {
  var scope = this.getScope();
  var strict = scope.strict;
  while (scope && scope !== this.global) {
    if (name in scope.properties) {
      scope.properties[name] = value;
      return undefined;
    }
    scope = scope.parentScope;
  }
  // The root scope is also an object which has readonly properties and
  // could also have setters.
  if (scope === this.global && (!strict || this.hasProperty(scope, name))) {
    return this.setProperty(scope, name, value);
  }
  this.throwException(this.REFERENCE_ERROR, name + ' ist nicht definiert');
};

/**
 * Create a new scope for the given node.
 * @param {!Object} node AST node (program or function).
 * @param {!Interpreter.Object} scope Scope dictionary to populate.
 * @private
 */
Interpreter.prototype.populateScope_ = function(node, scope) {
  if (node['type'] === 'VariableDeclaration') {
    for (var i = 0; i < node['declarations'].length; i++) {
      this.setProperty(scope, node['declarations'][i]['id']['name'],
          undefined, Interpreter.VARIABLE_DESCRIPTOR);
    }
  } else if (node['type'] === 'FunctionDeclaration') {
    this.setProperty(scope, node['id']['name'],
        this.createFunction(node, scope), Interpreter.VARIABLE_DESCRIPTOR);
    return;  // Do not recurse into function.
  } else if (node['type'] === 'FunctionExpression') {
    return;  // Do not recurse into function.
  } else if (node['type'] === 'ExpressionStatement') {
    return;  // Expressions can't contain variable/function declarations.
  }
  var nodeClass = node['constructor'];
  for (var name in node) {
    var prop = node[name];
    if (prop && typeof prop === 'object') {
      if (Array.isArray(prop)) {
        for (var i = 0; i < prop.length; i++) {
          if (prop[i] && prop[i].constructor === nodeClass) {
            this.populateScope_(prop[i], scope);
          }
        }
      } else {
        if (prop.constructor === nodeClass) {
          this.populateScope_(prop, scope);
        }
      }
    }
  }
};

/**
 * Remove start and end values from AST, or set start and end values to a
 * constant value.  Used to remove highlighting from polyfills and to set
 * highlighting in an eval to cover the entire eval expression.
 * @param {!Object} node AST node.
 * @param {number=} start Starting character of all nodes, or undefined.
 * @param {number=} end Ending character of all nodes, or undefined.
 * @private
 */
Interpreter.prototype.stripLocations_ = function(node, start, end) {
  if (start) {
    node['start'] = start;
  } else {
    delete node['start'];
  }
  if (end) {
    node['end'] = end;
  } else {
    delete node['end'];
  }
  for (var name in node) {
    if (node.hasOwnProperty(name)) {
      var prop = node[name];
      if (prop && typeof prop === 'object') {
        this.stripLocations_(prop, start, end);
      }
    }
  }
};

/**
 * Is the current state directly being called with as a construction with 'new'.
 * @return {boolean} True if 'new foo()', false if 'foo()'.
 */
Interpreter.prototype.calledWithNew = function() {
  return this.stateStack[this.stateStack.length - 1].isConstructor;
};

/**
 * Gets a value from the scope chain or from an object property.
 * @param {!Array} ref Name of variable or object/propname tuple.
 * @return {Interpreter.Value} Any value.
 *   May be flagged as being a getter and thus needing immediate execution
 *   (rather than being the value of the property).
 */
Interpreter.prototype.getValue = function(ref) {
  if (ref[0] === Interpreter.SCOPE_REFERENCE) {
    // A null/varname variable lookup.
    return this.getValueFromScope(ref[1]);
  } else {
    // An obj/prop components tuple (foo.bar).
    return this.getProperty(ref[0], ref[1]);
  }
};

/**
 * Sets a value to the scope chain or to an object property.
 * @param {!Array} ref Name of variable or object/propname tuple.
 * @param {Interpreter.Value} value Value.
 * @return {!Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
Interpreter.prototype.setValue = function(ref, value) {
  if (ref[0] === Interpreter.SCOPE_REFERENCE) {
    // A null/varname variable lookup.
    return this.setValueToScope(ref[1], value);
  } else {
    // An obj/prop components tuple (foo.bar).
    return this.setProperty(ref[0], ref[1], value);
  }
};

/**
 * Throw an exception in the interpreter that can be handled by an
 * interpreter try/catch statement.  If unhandled, a real exception will
 * be thrown.  Can be called with either an error class and a message, or
 * with an actual object to be thrown.
 * @param {!Interpreter.Object} errorClass Type of error (if message is
 *   provided) or the value to throw (if no message).
 * @param {string=} opt_message Message being thrown.
 */
Interpreter.prototype.throwException = function(errorClass, opt_message) {
  if (opt_message === undefined) {
    var error = errorClass;  // This is a value to throw, not an error class.
  } else {
    var error = this.createObject(errorClass);
    this.setProperty(error, 'message', opt_message,
        Interpreter.NONENUMERABLE_DESCRIPTOR);
  }
  this.executeException(error);
  // Abort anything related to the current step.
  throw Interpreter.STEP_ERROR;
};

/**
 * Throw an exception in the interpreter that can be handled by a
 * interpreter try/catch statement.  If unhandled, a real exception will
 * be thrown.
 * @param {!Interpreter.Object} error Error object to execute.
 */
Interpreter.prototype.executeException = function(error) {
  // Search for a try statement.
  do {
    this.stateStack.pop();
    var state = this.stateStack[this.stateStack.length - 1];
    if (state.node['type'] === 'TryStatement') {
      state.throwValue = error;
      return;
    }
  } while (state && state.node['type'] !== 'Program');

  // Throw a real error.
  var realError;
  if (this.isa(error, this.ERROR)) {
    var errorTable = {
      'EvalError': EvalError,
      'RangeError': RangeError,
      'ReferenceError': ReferenceError,
      'SyntaxError': SyntaxError,
      'TypeError': TypeError,
      'URIError': URIError
    };
    var name = this.getProperty(error, 'name').toString();
    var message = this.getProperty(error, 'message').valueOf();
    var type = errorTable[name] || Error;
    realError = type(message);
  } else {
    realError = error.toString();
  }
  throw realError;
};

/**
 * Create a call to a getter function.
 * @param {!Interpreter.Object} func Function to execute.
 * @param {!Interpreter.Object|!Array} left
 *     Name of variable or object/propname tuple.
 * @private
 */
Interpreter.prototype.createGetter_ = function(func, left) {
  // Normally 'this' will be specified as the object component (o.x).
  // Sometimes 'this' is explicitly provided (o).
  var funcThis = Array.isArray(left) ? left[0] : left;
  var node = new this.nodeConstructor();
  node['type'] = 'CallExpression';
  var state = new Interpreter.State(node,
      this.stateStack[this.stateStack.length - 1].scope);
  state.doneCallee_ = true;
  state.funcThis_ = funcThis;
  state.func_ = func;
  state.doneArgs_ = true;
  state.arguments_ = [];
  return state;
};

/**
 * Create a call to a setter function.
 * @param {!Interpreter.Object} func Function to execute.
 * @param {!Interpreter.Object|!Array} left
 *     Name of variable or object/propname tuple.
 * @param {Interpreter.Value} value Value to set.
 * @private
 */
Interpreter.prototype.createSetter_ = function(func, left, value) {
  // Normally 'this' will be specified as the object component (o.x).
  // Sometimes 'this' is implicitly the global object (x).
  var funcThis = Array.isArray(left) ? left[0] : this.global;
  var node = new this.nodeConstructor();
  node['type'] = 'CallExpression';
  var state = new Interpreter.State(node,
      this.stateStack[this.stateStack.length - 1].scope);
  state.doneCallee_ = true;
  state.funcThis_ = funcThis;
  state.func_ = func;
  state.doneArgs_ = true;
  state.arguments_ = [value];
  return state;
};

/**
 * Class for a state.
 * @param {!Object} node AST node for the state.
 * @param {!Interpreter.Object} scope Scope object for the state.
 * @constructor
 */
Interpreter.State = function(node, scope) {
  this.node = node;
  this.scope = scope;
};


///////////////////////////////////////////////////////////////////////////////
// Functions to handle each node type.
///////////////////////////////////////////////////////////////////////////////

Interpreter.prototype['stepArrayExpression'] = function(stack, state, node) {
  var elements = node['elements'];
  var n = state.n_ || 0;
  if (!state.array_) {
    state.array_ = this.createObjectProto(this.ARRAY_PROTO);
    state.array_.properties.length = elements.length;
  } else {
    this.setProperty(state.array_, n, state.value);
    n++;
  }
  while (n < elements.length) {
    // Skip missing elements - they're not defined, not undefined.
    if (elements[n]) {
      state.n_ = n;
      return new Interpreter.State(elements[n], state.scope);
    }
    n++;
  }
  stack.pop();
  stack[stack.length - 1].value = state.array_;
};

Interpreter.prototype['stepAssignmentExpression'] =
    function(stack, state, node) {
  if (!state.doneLeft_) {
    state.doneLeft_ = true;
    var nextState = new Interpreter.State(node['left'], state.scope);
    nextState.components = true;
    return nextState;
  }
  if (!state.doneRight_) {
    if (!state.leftReference_) {
      state.leftReference_ = state.value;
    }
    if (state.doneGetter_) {
      state.leftValue_ = state.value;
    }
    if (!state.doneGetter_ && node['operator'] !== '=') {
      var leftValue = this.getValue(state.leftReference_);
      state.leftValue_ = leftValue;
      if (leftValue && typeof leftValue === 'object' && leftValue.isGetter) {
        // Clear the getter flag and call the getter function.
        leftValue.isGetter = false;
        state.doneGetter_ = true;
        var func = /** @type {!Interpreter.Object} */ (leftValue);
        return this.createGetter_(func, state.leftReference_);
      }
    }
    state.doneRight_ = true;
    return new Interpreter.State(node['right'], state.scope);
  }
  if (state.doneSetter_) {
    // Return if setter function.
    // Setter method on property has completed.
    // Ignore its return value, and use the original set value instead.
    stack.pop();
    stack[stack.length - 1].value = state.doneSetter_;
    return;
  }
  var value = state.leftValue_;
  var rightValue = state.value;
  switch (node['operator']) {
    case '=':    value =    rightValue; break;
    case '+=':   value +=   rightValue; break;
    case '-=':   value -=   rightValue; break;
    case '*=':   value *=   rightValue; break;
    case '/=':   value /=   rightValue; break;
    case '%=':   value %=   rightValue; break;
    case '<<=':  value <<=  rightValue; break;
    case '>>=':  value >>=  rightValue; break;
    case '>>>=': value >>>= rightValue; break;
    case '&=':   value &=   rightValue; break;
    case '^=':   value ^=   rightValue; break;
    case '|=':   value |=   rightValue; break;
    default:
      throw SyntaxError('Unknown assignment expression: ' + node['operator']);
  }
  var setter = this.setValue(state.leftReference_, value);
  if (setter) {
    state.doneSetter_ = value;
    return this.createSetter_(setter, state.leftReference_, value);
  }
  // Return if no setter function.
  stack.pop();
  stack[stack.length - 1].value = value;
};

Interpreter.prototype['stepBinaryExpression'] = function(stack, state, node) {
  if (!state.doneLeft_) {
    state.doneLeft_ = true;
    return new Interpreter.State(node['left'], state.scope);
  }
  if (!state.doneRight_) {
    state.doneRight_ = true;
    state.leftValue_ = state.value;
    return new Interpreter.State(node['right'], state.scope);
  }
  stack.pop();
  var leftValue = state.leftValue_;
  var rightValue = state.value;
  var value;
  switch (node['operator']) {
    case '==':  value = leftValue ==  rightValue; break;
    case '!=':  value = leftValue !=  rightValue; break;
    case '===': value = leftValue === rightValue; break;
    case '!==': value = leftValue !== rightValue; break;
    case '>':   value = leftValue >   rightValue; break;
    case '>=':  value = leftValue >=  rightValue; break;
    case '<':   value = leftValue <   rightValue; break;
    case '<=':  value = leftValue <=  rightValue; break;
    case '+':   value = leftValue +   rightValue; break;
    case '-':   value = leftValue -   rightValue; break;
    case '*':   value = leftValue *   rightValue; break;
    case '/':   value = leftValue /   rightValue; break;
    case '%':   value = leftValue %   rightValue; break;
    case '&':   value = leftValue &   rightValue; break;
    case '|':   value = leftValue |   rightValue; break;
    case '^':   value = leftValue ^   rightValue; break;
    case '<<':  value = leftValue <<  rightValue; break;
    case '>>':  value = leftValue >>  rightValue; break;
    case '>>>': value = leftValue >>> rightValue; break;
    case 'in':
      if (!rightValue || !rightValue.isObject) {
        this.throwException(this.TYPE_ERROR,
            "'in' expects an object, not '" + rightValue + "'");
      }
      value = this.hasProperty(rightValue, leftValue);
      break;
    case 'instanceof':
      if (!this.isa(rightValue, this.FUNCTION)) {
        this.throwException(this.TYPE_ERROR,
            'Right-hand side of instanceof is not an object');
      }
      value = leftValue.isObject ? this.isa(leftValue, rightValue) : false;
      break;
    default:
      throw SyntaxError('Unknown binary operator: ' + node['operator']);
  }
  stack[stack.length - 1].value = value;
};

Interpreter.prototype['stepBlockStatement'] = function(stack, state, node) {
  var n = state.n_ || 0;
  var expression = node['body'][n];
  if (expression) {
    state.n_ = n + 1;
    return new Interpreter.State(expression, state.scope);
  }
  stack.pop();
};

Interpreter.prototype['stepBreakStatement'] = function(stack, state, node) {
  stack.pop();
  var label = null;
  if (node['label']) {
    label = node['label']['name'];
  }
  while (state &&
         state.node['type'] !== 'CallExpression' &&
         state.node['type'] !== 'NewExpression') {
    if (label) {
      if (state.labels && state.labels.indexOf(label) !== -1) {
        return;
      }
    } else if (state.isLoop || state.isSwitch) {
      return;
    }
    state = stack.pop();
  }
  // Syntax error, do not allow this error to be trapped.
  throw SyntaxError('Illegal break statement');
};

Interpreter.prototype['stepCallExpression'] = function(stack, state, node) {
  if (!state.doneCallee_) {
    state.doneCallee_ = 1;
    // Components needed to determine value of 'this'.
    var nextState = new Interpreter.State(node['callee'], state.scope);
    nextState.components = true;
    return nextState;
  }
  if (state.doneCallee_ === 1) {
    // Determine value of the function.
    state.doneCallee_ = 2;
    var func = state.value;
    if (Array.isArray(func)) {
      state.func_ = this.getValue(func);
      if (func[0] !== Interpreter.SCOPE_REFERENCE) {
        // Method function, 'this' is object (ignored if invoked as 'new').
        state.funcThis_ = func[0];
      }
      func = state.func_;
      if (func && typeof func === 'object' && func.isGetter) {
        // Clear the getter flag and call the getter function.
        func.isGetter = false;
        state.doneCallee_ = 1;
        return this.createGetter_(/** @type {!Interpreter.Object} */ (func),
                         state.value);
      }
    } else {
      // Already evaluated function: (function(){...})();
      state.func_ = func;
    }
    state.arguments_ = [];
    state.n_ = 0;
  }
  var func = state.func_;
  if (!state.doneArgs_) {
    if (state.n_ !== 0) {
      state.arguments_.push(state.value);
    }
    if (node['arguments'][state.n_]) {
      return new Interpreter.State(node['arguments'][state.n_++], state.scope);
    }
    // Determine value of 'this' in function.
    if (node['type'] === 'NewExpression') {
      if (func.illegalConstructor) {
        // Illegal: new escape();
        this.throwException(this.TYPE_ERROR, func + ' is not a constructor');
      }
      // Constructor, 'this' is new object.
      state.funcThis_ = this.createObject(func);
      state.isConstructor = true;
    } else if (state.funcThis_ === undefined) {
      // Global function, 'this' is global object (or 'undefined' if strict).
      state.funcThis_ = state.scope.strict ? undefined : this.global;
    }
    state.doneArgs_ = true;
  }
  if (!state.doneExec_) {
    state.doneExec_ = true;
    if (!func || !func.isObject) {
      this.throwException(this.TYPE_ERROR, func + ' ist keine Funktion');
    }
    var funcNode = func.node;
    if (funcNode) {
      var scope = this.createScope(funcNode['body'], func.parentScope);
      // Add all arguments.
      for (var i = 0; i < funcNode['params'].length; i++) {
        var paramName = funcNode['params'][i]['name'];
        var paramValue = state.arguments_.length > i ? state.arguments_[i] :
            undefined;
        this.setProperty(scope, paramName, paramValue);
      }
      // Build arguments variable.
      var argsList = this.createObjectProto(this.ARRAY_PROTO);
      for (var i = 0; i < state.arguments_.length; i++) {
        this.setProperty(argsList, i, state.arguments_[i]);
      }
      this.setProperty(scope, 'arguments', argsList);
      // Add the function's name (var x = function foo(){};)
      var name = funcNode['id'] && funcNode['id']['name'];
      if (name) {
        this.setProperty(scope, name, func);
      }
      this.setProperty(scope, 'this', state.funcThis_,
                       Interpreter.READONLY_DESCRIPTOR);
      state.value = undefined;  // Default value if no explicit return.
      return new Interpreter.State(funcNode['body'], scope);
    } else if (func.eval) {
      var code = state.arguments_[0];
      if (typeof code !== 'string') {
        // JS does not parse String objects:
        // eval(new String('1 + 1')) -> '1 + 1'
        state.value = code;
      } else {
        try {
          var ast = acorn.parse(code.toString(), Interpreter.PARSE_OPTIONS);
        } catch (e) {
          // Acorn threw a SyntaxError.  Rethrow as a trappable error.
          this.throwException(this.SYNTAX_ERROR, 'Invalid code: ' + e.message);
        }
        var evalNode = new this.nodeConstructor();
        evalNode['type'] = 'EvalProgram_';
        evalNode['body'] = ast['body'];
        this.stripLocations_(evalNode, node['start'], node['end']);
        // Update current scope with definitions in eval().
        var scope = state.scope;
        if (scope.strict) {
          // Strict mode get its own scope in eval.
          scope = this.createScope(ast, scope);
        } else {
          // Non-strict mode pollutes the current scope.
          this.populateScope_(ast, scope);
        }
        this.value = undefined;  // Default value if no code.
        return new Interpreter.State(evalNode, scope);
      }
    } else if (func.nativeFunc) {
      state.value = func.nativeFunc.apply(state.funcThis_, state.arguments_);
    } else if (func.asyncFunc) {
      var thisInterpreter = this;
      var callback = function(value) {
        state.value = value;
        thisInterpreter.paused_ = false;
      };
      var argsWithCallback = state.arguments_.concat(callback);
      this.paused_ = true;
      func.asyncFunc.apply(state.funcThis_, argsWithCallback);
      return;
    } else {
      /* A child of a function is a function but is not callable.  For example:
      var F = function() {};
      F.prototype = escape;
      var f = new F();
      f();
      */
      this.throwException(this.TYPE_ERROR, func.class + ' ist keine Funktion');
    }
  } else {
    // Execution complete.  Put the return value on the stack.
    stack.pop();
    if (state.isConstructor && typeof state.value !== 'object') {
      stack[stack.length - 1].value = state.funcThis_;
    } else {
      stack[stack.length - 1].value = state.value;
    }
  }
};

Interpreter.prototype['stepCatchClause'] = function(stack, state, node) {
  if (!state.done_) {
    state.done_ = true;
    // Create an empty scope.
    var scope = this.createSpecialScope(state.scope);
    // Add the argument.
    this.setProperty(scope, node['param']['name'], state.throwValue);
    // Execute catch clause.
    return new Interpreter.State(node['body'], scope);
  } else {
    stack.pop();
  }
};

Interpreter.prototype['stepConditionalExpression'] =
    function(stack, state, node) {
  var mode = state.mode_ || 0;
  if (mode === 0) {
    state.mode_ = 1;
    return new Interpreter.State(node['test'], state.scope);
  }
  if (mode === 1) {
    state.mode_ = 2;
    var value = Boolean(state.value);
    if (value && node['consequent']) {
      // Execute 'if' block.
      return new Interpreter.State(node['consequent'], state.scope);
    } else if (!value && node['alternate']) {
      // Execute 'else' block.
      return new Interpreter.State(node['alternate'], state.scope);
    }
    // eval('1;if(false){2}') -> undefined
    this.value = undefined;
  }
  stack.pop();
  if (node['type'] === 'ConditionalExpression') {
    stack[stack.length - 1].value = state.value;
  }
};

Interpreter.prototype['stepContinueStatement'] = function(stack, state, node) {
  stack.pop();
  var label = null;
  if (node['label']) {
    label = node['label']['name'];
  }
  state = stack[stack.length - 1];
  while (state &&
         state.node['type'] !== 'CallExpression' &&
         state.node['type'] !== 'NewExpression') {
    if (state.isLoop) {
      if (!label || (state.labels && state.labels.indexOf(label) !== -1)) {
        return;
      }
    }
    stack.pop();
    state = stack[stack.length - 1];
  }
  // Syntax error, do not allow this error to be trapped.
  throw SyntaxError('Illegal continue statement');
};

Interpreter.prototype['stepDebuggerStatement'] = function(stack, state, node) {
  // Do nothing.  May be overridden by developers.
  stack.pop();
};

Interpreter.prototype['stepDoWhileStatement'] = function(stack, state, node) {
  if (node['type'] === 'DoWhileStatement' && state.test_ === undefined) {
    // First iteration of do/while executes without checking test.
    state.value = true;
    state.test_ = true;
  }
  if (!state.test_) {
    state.test_ = true;
    return new Interpreter.State(node['test'], state.scope);
  }
  if (!state.value) {  // Done, exit loop.
    stack.pop();
  } else if (node['body']) {  // Execute the body.
    state.test_ = false;
    state.isLoop = true;
    return new Interpreter.State(node['body'], state.scope);
  }
};

Interpreter.prototype['stepEmptyStatement'] = function(stack, state, node) {
  stack.pop();
};

Interpreter.prototype['stepEvalProgram_'] = function(stack, state, node) {
  var n = state.n_ || 0;
  var expression = node['body'][n];
  if (expression) {
    state.n_ = n + 1;
    return new Interpreter.State(expression, state.scope);
  }
  stack.pop();
  stack[stack.length - 1].value = this.value;
};

Interpreter.prototype['stepExpressionStatement'] = function(stack, state, node) {
  if (!state.done_) {
    state.done_ = true;
    return new Interpreter.State(node['expression'], state.scope);
  }
  stack.pop();
  // Save this value to interpreter.value for use as a return value if
  // this code is inside an eval function.
  this.value = state.value;
};

Interpreter.prototype['stepForInStatement'] = function(stack, state, node) {
  // First, initialize a variable if exists.  Only do so once, ever.
  if (!state.doneInit_) {
    state.doneInit_ = true;
    if (node['left']['declarations'] &&
        node['left']['declarations'][0]['init']) {
      if (state.scope.strict) {
        this.throwException(this.SYNTAX_ERROR,
            'for-in loop variable declaration may not have an initializer.');
      }
      // Variable initialization: for (var x = 4 in y)
      return new Interpreter.State(node['left'], state.scope);
    }
  }
  // Second, look up the object.  Only do so once, ever.
  if (!state.doneObject_) {
    state.doneObject_ = true;
    if (!state.variable_) {
      state.variable_ = state.value;
    }
    return new Interpreter.State(node['right'], state.scope);
  }
  if (!state.isLoop) {
    // First iteration.
    state.isLoop = true;
    state.object_ = state.value;
    state.visited_ = Object.create(null);
  }
  // Third, find the property name for this iteration.
  if (state.name_ === undefined) {
    done: do {
      if (state.object_ && state.object_.isObject) {
        if (!state.props_) {
          state.props_ = Object.getOwnPropertyNames(state.object_.properties);
        }
        do {
          var prop = state.props_.shift();
        } while (prop && (state.visited_[prop] ||
            !Object.prototype.hasOwnProperty.call(state.object_.properties,
                                                  prop)));
        if (prop) {
          state.visited_[prop] = true;
          if (Object.prototype.propertyIsEnumerable.call(
              state.object_.properties, prop)) {
            state.name_ = prop;
            break done;
          }
        }
      } else if (state.object_ !== null) {
        if (!state.props_) {
          state.props_ = Object.getOwnPropertyNames(state.object_);
        }
        do {
          var prop = state.props_.shift();
        } while (prop && state.visited_[prop]);
        if (prop) {
          state.visited_[prop] = true;
          state.name_ = prop;
          break done;
        }
      }
      state.object_ = this.getPrototype(state.object_);
      state.props_ = null;
    } while (state.object_ !== null);
    if (state.object_ === null) {
      // Done, exit loop.
      stack.pop();
      return;
    }
  }
  // Fourth, find the variable
  if (!state.doneVariable_) {
    state.doneVariable_ = true;
    var left = node['left'];
    if (left['type'] === 'VariableDeclaration') {
      // Inline variable declaration: for (var x in y)
      state.variable_ =
          [Interpreter.SCOPE_REFERENCE, left['declarations'][0]['id']['name']];
    } else {
      // Arbitrary left side: for (foo().bar in y)
      state.variable_ = null;
      var nextState = new Interpreter.State(left, state.scope);
      nextState.components = true;
      return nextState;
    }
  }
  if (!state.variable_) {
    state.variable_ = state.value;
  }
  // Fifth, set the variable.
  if (!state.doneSetter_) {
    state.doneSetter_ = true;
    var value = state.name_;
    var setter = this.setValue(state.variable_, value);
    if (setter) {
      return this.createSetter_(setter, state.variable_, value);
    }
  }
  // Next step will be step three.
  state.name_ = undefined;
  // Reevaluate the variable since it could be a setter on the global object.
  state.doneVariable_ = false;
  state.doneSetter_ = false;
  // Sixth and finally, execute the body if there was one.  this.
  if (node['body']) {
    return new Interpreter.State(node['body'], state.scope);
  }
};

Interpreter.prototype['stepForStatement'] = function(stack, state, node) {
  var mode = state.mode_ || 0;
  if (mode === 0) {
    state.mode_ = 1;
    if (node['init']) {
      return new Interpreter.State(node['init'], state.scope);
    }
  } else if (mode === 1) {
    state.mode_ = 2;
    if (node['test']) {
      return new Interpreter.State(node['test'], state.scope);
    }
  } else if (mode === 2) {
    state.mode_ = 3;
    if (node['test'] && !state.value) {
      // Done, exit loop.
      stack.pop();
    } else {  // Execute the body.
      state.isLoop = true;
      return new Interpreter.State(node['body'], state.scope);
    }
  } else if (mode === 3) {
    state.mode_ = 1;
    if (node['update']) {
      return new Interpreter.State(node['update'], state.scope);
    }
  }
};

Interpreter.prototype['stepFunctionDeclaration'] =
    function(stack, state, node) {
  // This was found and handled when the scope was populated.
  stack.pop();
};

Interpreter.prototype['stepFunctionExpression'] = function(stack, state, node) {
  stack.pop();
  stack[stack.length - 1].value = this.createFunction(node, state.scope);
};

Interpreter.prototype['stepIdentifier'] = function(stack, state, node) {
  stack.pop();
  if (state.components) {
    stack[stack.length - 1].value = [Interpreter.SCOPE_REFERENCE, node['name']];
    return;
  }
  var value = this.getValueFromScope(node['name']);
  // An identifier could be a getter if it's a property on the global object.
  if (value && typeof value === 'object' && value.isGetter) {
    // Clear the getter flag and call the getter function.
    value.isGetter = false;
    var scope = state.scope;
    while (!this.hasProperty(scope, node['name'])) {
      scope = scope.parentScope;
    }
    var func = /** @type {!Interpreter.Object} */ (value);
    return this.createGetter_(func, this.global);
  }
  stack[stack.length - 1].value = value;
};

Interpreter.prototype['stepIfStatement'] =
    Interpreter.prototype['stepConditionalExpression'];

Interpreter.prototype['stepLabeledStatement'] = function(stack, state, node) {
  // No need to hit this node again on the way back up the stack.
  stack.pop();
  // Note that a statement might have multiple labels.
  var labels = state.labels || [];
  labels.push(node['label']['name']);
  var nextState = new Interpreter.State(node['body'], state.scope);
  nextState.labels = labels;
  return nextState;
};

Interpreter.prototype['stepLiteral'] = function(stack, state, node) {
  stack.pop();
  var value = node['value'];
  if (value instanceof RegExp) {
    var pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
    this.populateRegExp(pseudoRegexp, value);
    value = pseudoRegexp;
  }
  stack[stack.length - 1].value = value;
};

Interpreter.prototype['stepLogicalExpression'] = function(stack, state, node) {
  if (node['operator'] !== '&&' && node['operator'] !== '||') {
    throw SyntaxError('Unknown logical operator: ' + node['operator']);
  }
  if (!state.doneLeft_) {
    state.doneLeft_ = true;
    return new Interpreter.State(node['left'], state.scope);
  }
  if (!state.doneRight_) {
    if ((node['operator'] === '&&' && !state.value) ||
        (node['operator'] === '||' && state.value)) {
      // Shortcut evaluation.
      stack.pop();
      stack[stack.length - 1].value = state.value;
    } else {
      state.doneRight_ = true;
      return new Interpreter.State(node['right'], state.scope);
    }
  } else {
    stack.pop();
    stack[stack.length - 1].value = state.value;
  }
};

Interpreter.prototype['stepMemberExpression'] = function(stack, state, node) {
  if (!state.doneObject_) {
    state.doneObject_ = true;
    return new Interpreter.State(node['object'], state.scope);
  }
  var propName;
  if (!node['computed']) {
    state.object_ = state.value;
    // obj.foo -- Just access 'foo' directly.
    propName = node['property']['name'];
  } else if (!state.doneProperty_) {
    state.object_ = state.value;
    // obj[foo] -- Compute value of 'foo'.
    state.doneProperty_ = true;
    return new Interpreter.State(node['property'], state.scope);
  } else {
    propName = state.value;
  }
  stack.pop();
  if (state.components) {
    stack[stack.length - 1].value = [state.object_, propName];
  } else {
    var value = this.getProperty(state.object_, propName);
    if (value && typeof value === 'object' && value.isGetter) {
      // Clear the getter flag and call the getter function.
      value.isGetter = false;
      var func = /** @type {!Interpreter.Object} */ (value);
      return this.createGetter_(func, state.object_);
    }
    stack[stack.length - 1].value = value;
  }
};

Interpreter.prototype['stepNewExpression'] =
    Interpreter.prototype['stepCallExpression'];

Interpreter.prototype['stepObjectExpression'] = function(stack, state, node) {
  var n = state.n_ || 0;
  var property = node['properties'][n];
  if (!state.object_) {
    // First execution.
    state.object_ = this.createObjectProto(this.OBJECT_PROTO);
    state.properties_ = Object.create(null);
  } else {
    // Determine property name.
    var key = property['key'];
    if (key['type'] === 'Identifier') {
      var propName = key['name'];
    } else if (key['type'] === 'Literal') {
      var propName = key['value'];
    } else {
      throw SyntaxError('Unknown object structure: ' + key['type']);
    }
    // Set the property computed in the previous execution.
    if (!state.properties_[propName]) {
      // Create temp object to collect value, getter, and/or setter.
      state.properties_[propName] = {};
    }
    state.properties_[propName][property['kind']] = state.value;
    state.n_ = ++n;
    property = node['properties'][n];
  }
  if (property) {
    return new Interpreter.State(property['value'], state.scope);
  }
  for (var key in state.properties_) {
    var kinds = state.properties_[key];
    if ('get' in kinds || 'set' in kinds) {
      // Set a property with a getter or setter.
      var descriptor = {
        configurable: true,
        enumerable: true,
        get: kinds['get'],
        set: kinds['set']
      };
      this.setProperty(state.object_, key, null, descriptor);
    } else {
      // Set a normal property with a value.
      this.setProperty(state.object_, key, kinds['init']);
    }
  }
  stack.pop();
  stack[stack.length - 1].value = state.object_;
};

Interpreter.prototype['stepProgram'] = function(stack, state, node) {
  var n = state.n_ || 0;
  var expression = node['body'][n];
  if (expression) {
    state.done = false;
    state.n_ = n + 1;
    return new Interpreter.State(expression, state.scope);
  }
  state.done = true;
  // Don't pop the stateStack.
  // Leave the root scope on the tree in case the program is appended to.
};

Interpreter.prototype['stepReturnStatement'] = function(stack, state, node) {
  if (node['argument'] && !state.done_) {
    state.done_ = true;
    return new Interpreter.State(node['argument'], state.scope);
  }
  var value = state.value;
  var i = stack.length - 1;
  state = stack[i];
  while (state.node['type'] !== 'CallExpression' &&
         state.node['type'] !== 'NewExpression') {
    if (state.node['type'] !== 'TryStatement') {
      stack.splice(i, 1);
    }
    i--;
    if (i < 0) {
      // Syntax error, do not allow this error to be trapped.
      throw SyntaxError('Illegal return statement');
    }
    state = stack[i];
  }
  state.value = value;
};

Interpreter.prototype['stepSequenceExpression'] = function(stack, state, node) {
  var n = state.n_ || 0;
  var expression = node['expressions'][n];
  if (expression) {
    state.n_ = n + 1;
    return new Interpreter.State(expression, state.scope);
  }
  stack.pop();
  stack[stack.length - 1].value = state.value;
};

Interpreter.prototype['stepSwitchStatement'] = function(stack, state, node) {
  if (!state.test_) {
    state.test_ = 1;
    return new Interpreter.State(node['discriminant'], state.scope);
  }
  if (state.test_ === 1) {
    state.test_ = 2;
    // Preserve switch value between case tests.
    state.switchValue_ = state.value;
  }

  while (true) {
    var index = state.index_ || 0;
    var switchCase = node['cases'][index];
    if (!state.matched_ && switchCase && !switchCase['test']) {
      // Test on the default case is null.
      // Bypass (but store) the default case, and get back to it later.
      state.defaultCase_ = index;
      state.index_ = index + 1;
      continue;
    }
    if (!switchCase && !state.matched_ && state.defaultCase_) {
      // Ran through all cases, no match.  Jump to the default.
      state.matched_ = true;
      state.index_ = state.defaultCase_;
      continue;
    }
    if (switchCase) {
      if (!state.matched_ && !state.tested_ && switchCase['test']) {
        state.tested_ = true;
        return new Interpreter.State(switchCase['test'], state.scope);
      }
      if (state.matched_ || state.value === state.switchValue_) {
        state.matched_ = true;
        var n = state.n_ || 0;
        if (switchCase['consequent'][n]) {
          state.isSwitch = true;
          state.n_ = n + 1;
          return new Interpreter.State(switchCase['consequent'][n],
                                       state.scope);
        }
      }
      // Move on to next case.
      state.tested_ = false;
      state.n_ = 0;
      state.index_ = index + 1;
    } else {
      stack.pop();
      return;
    }
  }
};

Interpreter.prototype['stepThisExpression'] = function(stack, state, node) {
  stack.pop();
  stack[stack.length - 1].value = this.getValueFromScope('this');
};

Interpreter.prototype['stepThrowStatement'] = function(stack, state, node) {
  if (!state.done_) {
    state.done_ = true;
    return new Interpreter.State(node['argument'], state.scope);
  } else {
    this.throwException(state.value);
  }
};

Interpreter.prototype['stepTryStatement'] = function(stack, state, node) {
  if (!state.doneBlock_) {
    state.doneBlock_ = true;
    return new Interpreter.State(node['block'], state.scope);
  }
  if (state.throwValue && !state.doneHandler_ && node['handler']) {
    state.doneHandler_ = true;
    var nextState = new Interpreter.State(node['handler'], state.scope);
    nextState.throwValue = state.throwValue;
    state.throwValue = null;  // This error has been handled, don't rethrow.
    return nextState;
  }
  if (!state.doneFinalizer_ && node['finalizer']) {
    state.doneFinalizer_ = true;
    return new Interpreter.State(node['finalizer'], state.scope);
  }
  if (state.throwValue) {
    // There was no catch handler, or the catch/finally threw an error.
    // Throw the error up to a higher try.
    this.executeException(state.throwValue);
  } else {
    stack.pop();
  }
};

Interpreter.prototype['stepUnaryExpression'] = function(stack, state, node) {
  if (!state.done_) {
    state.done_ = true;
    var nextState = new Interpreter.State(node['argument'], state.scope);
    nextState.components = node['operator'] === 'delete';
    return nextState;
  }
  stack.pop();
  var value = state.value;
  if (node['operator'] === '-') {
    value = -value;
  } else if (node['operator'] === '+') {
    value = +value;
  } else if (node['operator'] === '!') {
    value = !value;
  } else if (node['operator'] === '~') {
    value = ~value;
  } else if (node['operator'] === 'delete') {
    var result = true;
    // If value is not an array, then it is a primitive, or some other value.
    // If so, skip the delete and return true.
    if (Array.isArray(value)) {
      var obj = value[0];
      if (obj === Interpreter.SCOPE_REFERENCE) {
        // 'delete foo;' is the same as 'delete window.foo'.
        obj = state.scope;
      }
      var name = String(value[1]);
      try {
        delete obj.properties[name];
      } catch (e) {
        if (state.scope.strict) {
          this.throwException(this.TYPE_ERROR, "Cannot delete property '" +
                              name + "' of '" + obj + "'");
        } else {
          result = false;
        }
      }
    }
    value = result;
  } else if (node['operator'] === 'typeof') {
    value = (value && value.class === 'Function') ? 'function' : typeof value;
  } else if (node['operator'] === 'void') {
    value = undefined;
  } else {
    throw SyntaxError('Unknown unary operator: ' + node['operator']);
  }
  stack[stack.length - 1].value = value;
};

Interpreter.prototype['stepUpdateExpression'] = function(stack, state, node) {
  if (!state.doneLeft_) {
    state.doneLeft_ = true;
    var nextState = new Interpreter.State(node['argument'], state.scope);
    nextState.components = true;
    return nextState;
  }
  if (!state.leftSide_) {
    state.leftSide_ = state.value;
  }
  if (state.doneGetter_) {
    state.leftValue_ = state.value;
  }
  if (!state.doneGetter_) {
    var leftValue = this.getValue(state.leftSide_);
    state.leftValue_ = leftValue;
    if (leftValue && typeof leftValue === 'object' && leftValue.isGetter) {
      // Clear the getter flag and call the getter function.
      leftValue.isGetter = false;
      state.doneGetter_ = true;
      var func = /** @type {!Interpreter.Object} */ (leftValue);
      return this.createGetter_(func, state.leftSide_);
    }
  }
  if (state.doneSetter_) {
    // Return if setter function.
    // Setter method on property has completed.
    // Ignore its return value, and use the original set value instead.
    stack.pop();
    stack[stack.length - 1].value = state.doneSetter_;
    return;
  }
  var leftValue = Number(state.leftValue_);
  var changeValue;
  if (node['operator'] === '++') {
    changeValue = leftValue + 1;
  } else if (node['operator'] === '--') {
    changeValue = leftValue - 1;
  } else {
    throw SyntaxError('Unknown update expression: ' + node['operator']);
  }
  var returnValue = node['prefix'] ? changeValue : leftValue;
  var setter = this.setValue(state.leftSide_, changeValue);
  if (setter) {
    state.doneSetter_ = returnValue;
    return this.createSetter_(setter, state.leftSide_, changeValue);
  }
  // Return if no setter function.
  stack.pop();
  stack[stack.length - 1].value = returnValue;
};

Interpreter.prototype['stepVariableDeclaration'] = function(stack, state, node) {
  var declarations = node['declarations'];
  var n = state.n_ || 0;
  var declarationNode = declarations[n];
  if (state.init_ && declarationNode) {
    // This setValue call never needs to deal with calling a setter function.
    // Note that this is setting the init value, not defining the variable.
    // Variable definition is done when scope is populated.
    this.setValueToScope(declarationNode['id']['name'], state.value);
    state.init_ = false;
    declarationNode = declarations[++n];
  }
  while (declarationNode) {
    // Skip any declarations that are not initialized.  They have already
    // been defined as undefined in populateScope_.
    if (declarationNode['init']) {
      state.n_ = n;
      state.init_ = true;
      return new Interpreter.State(declarationNode['init'], state.scope);
    }
    declarationNode = declarations[++n];
  }
  stack.pop();
};

Interpreter.prototype['stepWithStatement'] = function(stack, state, node) {
  if (!state.doneObject_) {
    state.doneObject_ = true;
    return new Interpreter.State(node['object'], state.scope);
  } else if (!state.doneBody_) {
    state.doneBody_ = true;
    var scope = this.createSpecialScope(state.scope, state.value);
    return new Interpreter.State(node['body'], scope);
  } else {
    stack.pop();
  }
};

Interpreter.prototype['stepWhileStatement'] =
    Interpreter.prototype['stepDoWhileStatement'];

// Preserve top-level API functions from being pruned/renamed by JS compilers.
// Add others as needed.
// The global object ('window' in a browser, 'global' in node.js) is 'this'.
this['Interpreter'] = Interpreter;
Interpreter.prototype['step'] = Interpreter.prototype.step;
Interpreter.prototype['run'] = Interpreter.prototype.run;
Interpreter.prototype['appendCode'] = Interpreter.prototype.appendCode;
Interpreter.prototype['createObject'] = Interpreter.prototype.createObject;
Interpreter.prototype['createObjectProto'] =
    Interpreter.prototype.createObjectProto;
Interpreter.prototype['createAsyncFunction'] =
    Interpreter.prototype.createAsyncFunction;
Interpreter.prototype['createNativeFunction'] =
    Interpreter.prototype.createNativeFunction;
Interpreter.prototype['getProperty'] = Interpreter.prototype.getProperty;
Interpreter.prototype['setProperty'] = Interpreter.prototype.setProperty;
Interpreter.prototype['nativeToPseudo'] = Interpreter.prototype.nativeToPseudo;
Interpreter.prototype['pseudoToNative'] = Interpreter.prototype.pseudoToNative;
// Obsolete.  Do not use.
Interpreter.prototype['createPrimitive'] = function(x) {return x;};
