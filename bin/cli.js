#!/usr/bin/env node
var argv = require('optimist').argv;
var propagit = require('../');
var spawn = require('child_process').spawn;
var path = require('path');

var cmd = argv._[0];

if (cmd === 'drone') {
    var hub = parseAddr(argv.hub);
    
    propagit(argv).connect(hub, function (c) {
        c.on('error', function (err) {
            console.error(err && err.stack || err);
        });
        
        c.on('up', function () {
            console.log('connected to the hub');
        });
        
        c.on('reconnect', function () {
            console.log('reconnecting to the hub');
        });
        
        c.on('down', function () {
            console.log('disconnected from the hub');
        });
        
        function spawner (cmd, args, emit, opts) {
            console.log(cmd + ' ' + args.join(' '));
            
            if (!opts) opts = { cwd : c.repodir };
            var ps = spawn(cmd, args, opts);
            
            if (typeof emit === 'function') {
                ps.stdout.on('data', function (buf) {
                    emit('data', buf.toString());
                });
                ps.stderr.on('data', function (buf) {
                    emit('data', buf.toString());
                });
                var pending = 2;
                var onend = function () {
                    if (--pending === 0) emit('end')
                };
                ps.stdout.on('end', onend);
                ps.stderr.on('end', onend);
            }
        }
        c.on('spawn', function (cmd, args, emit, opts) {
            if (opts && opts.repo && opts.commit) {
                opts.cwd = path.join(c.deploydir, opts.repo + '.' + opts.commit);
            }
            spawner(cmd, args, emit, opts);
        });
        
        function create (repo, emit) {
            path.exists(path.join(c.repodir, repo + '.git'), function (ex) {
                if (ex) {
                    if (typeof emit === 'function') {
                        emit('end');
                    }
                    else if (typeof emit === 'object') {
                        if (emit.stdout) emit.stdout('end');
                        if (emit.stderr) emit.stderr('end');
                    }
                }
                else spawner('git',
                    [ 'init', '--bare', path.join(c.repodir, repo + '.git') ],
                    emit
                )
            });
        }
        c.on('fetch', function (repo, emit) {
            create(repo, function (name) {
                if (typeof emit === 'function') emit.apply(null, arguments);
                if (name === 'end') {
                    spawner('git', [
                        'fetch',
                        'http://' + hub.host + ':' + c.ports.git + '/' + repo
                    ], emit, { cwd : path.join(c.repodir, repo + '.git') });
                }
            });
        });
        
        c.on('deploy', function (repo, commit, emit) {
            var dir = path.join(c.deploydir, repo + '.' + commit);
            spawner('git', [
                'clone',
                path.join(c.repodir, repo + '.git'),
                dir
            ], function (name) {
                if (name === 'end') {
                    spawner('git',
                        [ 'checkout', commit ],
                        emit,
                        { cwd : dir }
                    );
                }
            });
        });
    });
}
else if (cmd === 'hub') {
    var cport = argv.cport || argv.port;
    var gport = argv.gport || cport + 1;
    
    propagit(argv).listen(cport, gport);
    console.log('control service listening on :' + cport);
    console.log('git service listening on :' + gport);
}
else if (cmd === 'deploy') {
    var repo = argv._[1];
    var commit = argv._[2];
    var dcmd = argv._[3] ? argv._.slice(3) : null;
    var hub = parseAddr(argv.hub);
    propagit(argv).deploy(hub, repo, commit, dcmd, function (name, buf) {
        if (name === 'data') console.log(buf);
        else if (name === 'end') process.exit();
    });
}
else {
    console.log([
        'Usage:',
        '  propagit OPTIONS hub',
        '    Create a server to coordinate drones.',
        '    --port       port to listen on',
        '    --secret     password to use',
        '    --repodir    git repository directory',
        '',
        '  propagit OPTIONS drone',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
        '    --role       service role to be',
        '',
        '  propagit OPTIONS deploy REPO COMMIT [COMMAND...]',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
        '    --role       deploy under this role',
        '',
    ].join('\n'));
}

function parseAddr (addr) {
    var s = addr.toString().split(':');
    return {
        host : s[1] ? s[0] : 'localhost',
        port : parseInt(s[1] || s[0], 10),
    };
}
