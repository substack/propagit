var http = require('http');

module.exports = function (repos, secret) {
    return http.createServer(function (req, res) {
        return repos.handle(req, res);
    });
};
