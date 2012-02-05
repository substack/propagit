var test = require('tap').test;

var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');

var mkdirp = require('mkdirp');
var http = require('http');

var cmd = __dirname + '/../bin/cli.js';
var tmpdir = '/tmp/' + Math.floor(Math.random() * (1<<24)).toString(16);
var dirs = {
    hub : tmpdir + '/hub',
    drone : tmpdir + '/drone',
    repo : tmpdir + '/webapp',
};
mkdirp.sync(dirs.hub);
mkdirp.sync(dirs.drone);
mkdirp.sync(dirs.repo);

var src = fs.readFileSync(__dirname + '/webapp/server.js');
fs.writeFileSync(dirs.repo + '/server.js', src);

test('command line deploy', function (t) {
    var ps = {};
    ps.hub = spawn(
        cmd, [ 'hub', '--port=6000', '--secret=beepboop' ],
        { cwd : dirs.hub }
    );
    ps.hub.stdout.pipe(process.stdout, { end : false });
    ps.hub.stderr.pipe(process.stderr, { end : false });
    
    ps.drone = spawn(
        cmd, [ 'drone', '--hub=localhost:6000', '--secret=beepboop' ],
        { cwd : dirs.drone }
    );
    ps.drone.stdout.pipe(process.stdout, { end : false });
    ps.drone.stderr.pipe(process.stderr, { end : false });
    
    setTimeout(function () {
        var opts = { cwd : dirs.repo };
        var commands = [
            'git init',
            'git add server.js',
            'git commit -m"web server"',
            'git log|head -n1',
            function (line) {
                var commit = line.split(/\s+/)[1]
                exec(
                    'git push http://localhost:6001/webapp.git master',
                    opts,
                    deploy.bind(null, commit)
                );
            }
        ];
        (function pop (s) {
            var cmd = commands.shift();
            if (!cmd) return;
            else if (typeof cmd === 'string') {
                exec(cmd, opts, function (err, out) {
                    pop(out);
                });
            }
            else if (typeof cmd === 'function') {
                cmd(s);
            }
        })();
    }, 2000);
    
    function deploy (commit, err, stdout, stderr) {
        if (err) t.fail(err);
        ps.deploy = spawn(cmd, [
            'deploy', '--hub=localhost:6000', '--secret=beepboop',
            'webapp', commit
        ]);
        ps.deploy.on('exit', run.bind(null, commit));
    }
    
    function run (commit) {
        ps.run = spawn(cmd, [
            'spawn', '--hub=localhost:6000', '--secret=beepboop',
            'webapp', commit,
            'node', 'server.js', '8085',
        ]);
        ps.run.on('exit', function () {
            setTimeout(testServer, 500);
        });
    }
    
    function testServer () {
        var opts = { host : 'localhost', port : 8085, path : '/' };
        http.get(opts, function (res) {
            var data = '';
            res.on('data', function (buf) { data += buf });
            res.on('end', function () {
                t.equal(data, 'beep boop');
                t.end();
            });
        });
    }
    
    t.on('end', function () {
        Object.keys(ps).forEach(function (name) {
            ps[name].kill();
        });
    });
});
