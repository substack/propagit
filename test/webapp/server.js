var http = require('http');
var port = parseInt(process.argv[2], 10);

http.createServer(function (req, res) {
    res.end(JSON.stringify([ 'beepity', process.env ]));
}).listen(port);
