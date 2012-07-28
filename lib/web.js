var http = require('http');

module.exports = function (repos, secret) {
    return http.createServer(function (req, res) {
        if (!secret) return repos.handle(req, res);
        
        if (!req.headers.authorization) {
            res.statusCode = 401;
            res.setHeader('www-authenticate', 'Basic');
            res.end('must authenticate with basic auth');
            return;
        }
        var m = req.headers.authorization.match(/^Basic (\S+)/);
        if (!m) {
            res.statusCode = 401;
            return res.end('unsupported authorization format');
        }
        
        var s = Buffer(m[1], 'base64').toString().split(':');
        if (s[0] !== 'git' || s[1] !== secret) {
            res.statusCode = 401;
            return res.end('invalid secret phrase');
        }
        
        return repos.handle(req, res);
    });
};
