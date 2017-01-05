"use strict";

var _Promise = require("babel-runtime/core-js/promise")["default"];

var _interopRequireDefault = require("babel-runtime/helpers/interop-require-default")["default"];

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _superagent = require("superagent");

var _superagent2 = _interopRequireDefault(_superagent);

var _srcIndex = require("../src/index");

var _srcIndex2 = _interopRequireDefault(_srcIndex);

var JSONAPIContentType = "application/vnd.api+json";
_superagent2["default"].serialize[JSONAPIContentType] = JSON.stringify;
_superagent2["default"].parse[JSONAPIContentType] = _superagent2["default"].parse["application/json"];

/**
 * Export a Promise for a module that can make requests to the app.
 */
exports["default"] = _srcIndex2["default"].then(function (app) {
  var port = process.env.PORT || "3000";
  var host = process.env.HOST || "127.0.0.1";

  app.baseUrl = "http://" + host + ":" + port;

  return new _Promise(function (resolve, reject) {
    app.listen(port, host, function () {
      resolve({
        request: function request(method, url) {
          var req = _superagent2["default"][method.toLowerCase()](app.baseUrl + url).buffer(true);
          req.promise = function () {
            return new _Promise(function (resolveInner, rejectInner) {
              return req.end(function (err, res) {
                return err ? rejectInner(err) : resolveInner(res);
              });
            });
          };
          return req;
        },
        superagent: _superagent2["default"]
      });
    });
  });
});
module.exports = exports["default"];