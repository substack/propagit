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
    var port = Math.floor(Math.random() * 5e4 + 1e4);
    var httpPort = Math.floor(Math.random() * 5e4 + 1e4);
    
    var ps = {};
    ps.hub = spawn(
        cmd, [ 'hub', '--port=' + port, '--secret=beepboop' ],
        { cwd : dirs.hub }
    );
    
    ps.drone = spawn(
        cmd, [ 'drone', '--hub=localhost:' + port, '--secret=beepboop' ],
        { cwd : dirs.drone }
    );
    
    setTimeout(function () {
        var opts = { cwd : dirs.repo };
        var commands = [
            'git init',
            'git add server.js',
            'git commit -m"web server"',
            'git log|head -n1',
            function (line) {
                var commit = line.split(/\s+/)[1];
                exec(
                    'git push http://git:beepboop@localhost:'
                        + (port + 1)
                        + '/webapp.git master',
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
                    if (err) t.fail(err);
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
            'deploy', '--hub=localhost:' + port, '--secret=beepboop',
            'webapp', commit
        ]);
        
        ps.deploy.on('exit', run.bind(null, commit));
    }
    
    function run (commit) {
        ps.run = spawn(cmd, [
            'spawn', '--hub=localhost:' + port, '--secret=beepboop',
            '--env.PROPAGIT_BEEPITY=boop',
            'webapp', commit,
            'node', 'server.js', httpPort,
        ]);
        setTimeout(testServer, 2000);
    }
    
    function testServer () {
        var opts = { host : 'localhost', port : httpPort, path : '/' };
        http.get(opts, function (res) {
            var data = '';
            res.on('data', function (buf) { data += buf });
            res.on('end', function () {
                var obj = JSON.parse(data);
                t.equal(obj[0], 'beepity');
                t.equal(obj[1].REPO, 'webapp');
                t.ok(obj[1].COMMIT.match(/^[0-9a-f]{40}$/));
                t.equal(obj[1].PROPAGIT_BEEPITY, 'boop');
                t.ok(obj[1].PROCESS_ID.match(/^[0-9a-f]+$/));
                
                var droneId = obj[1].DRONE_ID;
                
                ps.ps = spawn(cmd, [
                    'ps', '--json',
                    '--hub=localhost:' + port, '--secret=beepboop',
                ]);
                readPs(ps.ps, droneId);
            });
        });
    }
    
    function readPs (p, droneId) {
        var json = '';
        p.stdout.on('data', function (buf) { json += buf });
        p.stdout.on('end', function () {
            var obj = JSON.parse(json);
            t.equal(Object.keys(obj)[0], droneId);
            t.end();
        });
    }
    
    t.on('end', function () {
        Object.keys(ps).forEach(function (name) {
            ps[name].kill();
        });
    });
});
