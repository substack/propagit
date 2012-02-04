var dnode = require('dnode');
var upnode = require('upnode');
var pushover = require('pushover');
var mkdirp = require('mkdirp');
var procs = require('procstreams');
var spawn = require('child_process').spawn;

var fs = require('fs');
var path = require('path');
var Stream = require('stream').Stream;

module.exports = function (secret) {
    return new Propagit(secret);
};

var logger = function (uid) {
    return function (name, buf) {
        if (name === 'data') {
            var lines = buf.toString().split('\n');
            lines.forEach(function (line) {
                console.log('[' + uid + '] ' + line);
            });
        }
    };
};

function Propagit (opts) {
    if (typeof opts === 'string') {
        opts = { secret : opts };
    }
    
    this.readable = true;
    this.secret = opts.secret;
    
    var base = opts.basedir || process.cwd();
    this.repodir = path.resolve(opts.repodir || base + '/repos');
    this.deploydir = path.resolve(opts.deploydir || base + '/deploy');
}

Propagit.prototype = new Stream;

Propagit.prototype.connect = function () {
    var self = this;
    mkdirp(self.deploydir);
    mkdirp(self.repodir);
    
    var argv = [].slice.call(arguments).reduce(function (acc, arg) {
        if (typeof arg === 'function') acc.cb = arg
        else acc.args.push(arg)
        return acc;
    }, { args : [] });
    
    var cb = argv.cb;
    var args = argv.args.concat(function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) self.emit('error', err)
            else {
                self.ports = res.ports;
                conn.emit('up', res);
            };
        });
    });
    
    var uid = (Math.random() * Math.pow(16,8)).toString(16);
    var inst = upnode(function (remote, conn) {
        this.name = (args.object || {}).name || Math.floor(
            Math.random() * (1<<24)
        ).toString(16);
        
        this.spawn = function (repo, commit, emit) {
            self.emit('spawn', repo, commit, emit);
        };
        
        this.fetch = function (repo, emit) {
            self.emit('fetch', repo, emit);
        };
        
        this.deploy = function (opts, emit) {
            self.emit('deploy', opts, emit);
        };
        
        this.name = uid;
        this.role = 'drone';
    });
    var hub = self.hub = inst.connect.apply(inst, args);
    
    [ 'up', 'reconnect', 'down' ].forEach(function (name) {
        hub.on(name, self.emit.bind(self, name));
    });
    
    cb(self);
    return self;
};

Propagit.prototype.listen = function (controlPort, gitPort) {
    var self = this;
    mkdirp(self.repodir);
    self.drones = [];
    self.ports = {
        control : controlPort,
        git : gitPort,
    };
    
    var server = dnode(function (remote, conn) {
        this.auth = function (secret, cb) {
            if (typeof cb !== 'function') return
            else if (self.secret === secret) {
                if (remote.role === 'drone') {
                    self.drones.push(remote);
                    conn.on('end', function () {
                        var ix = self.drones.indexOf(remote);
                        if (ix >= 0) self.drones.splice(ix, 1);
                    });
                }
                
                cb(null, self.createService(self, remote));
                
                if (remote.role === 'drone') {
                    fs.readdir(self.repodir, function (err, repos) {
                        if (err) console.error(err)
                        else repos.forEach(function (repo) {
                            remote.fetch(repo, logger(remote.name));
                        });
                    });
                }
            }
            else cb('ACCESS DENIED')
        };
    });
    server.use(upnode.ping);
    server.listen(controlPort);
    
    var repos = self.repos = pushover(self.repodir);
    repos.on('push', function (repo) {
        self.emit('push', repo);
        self.drones.forEach(function (drone) {
            drone.fetch(repo, logger(drone.name));
        });
    });
    repos.listen(gitPort);
    
    return self;
};

Propagit.prototype.createService = function (remote) {
    var self = this;
    
    function getDrones (opts) {
        var names = opts.drone ? [ opts.drone ] : opts.drones;
        var dnames = self.drones.map(function (d) { return d.name });
        
        if (names) {
            return names.map(function (name) {
                var ix = dnames.indexOf(name);
                return self.drones[ix];
            }).filter(Boolean);
        }
        else {
            var ix = Math.floor(Math.random() * self.drones.length);
            var drone = self.drones[ix];
            return drone ? [ drone ] : [];
        }
    }
    
    var service = { ports : self.ports };
    
    service.drones = function (cb) {
        if (typeof cb !== 'function') return;
        cb(self.drones.map(function (d) { return d.name }));
    };
    
    service.deploy = function (opts, cb) {
        getDrones(opts).forEach(function (drone) {
            self.emit('deploy', drone.name, opts);
            drone.deploy(opts, cb);
        });
    };
    
    service.spawn = function (opts) {
        getDrones(opts).forEach(function (drone) {
        });
    };
    
    return service;
};

Propagit.prototype.deploy = function (hub, opts) {
    var self = this;
    var stream = new Stream;
    stream.readable = true;
    
    dnode.connect(hub.host, hub.port, function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) { 
                stream.emit('error', err);
                conn.end();
            }
            else {
                res.deploy(opts, stream.emit.bind(stream));
                stream.on('end', conn.end.bind(conn));
            }
        });
    });
    
    return stream;
};

Propagit.prototype.drone = function (hub) {
    var self = this;
    
    self.connect(hub, function (c) {
        function refs (repo) {
            return {
                origin : 'http://' + hub.host + ':' + c.ports.git + '/' + repo,
                repodir : path.join(c.repodir, repo + '.git'),
            }
        }
        c.on('error', self.emit.bind(self, 'error'));
        
        c.on('fetch', function (repo, emit) {
            var p = refs(repo);
            procs('git', [ 'init', '--bare', p.repodir ])
                .then('git', [ 'fetch', p.origin ], { cwd : p.repodir })
            ;
        });
        
        c.on('deploy', function (opts, emit) {
            var repo = opts.repo;
            var commit = opts.commit;
            
            var cmd = opts.command[0];
            var args = opts.command.slice(1);
            
            var dir = path.join(c.deploydir, repo + '.' + commit);
            var p = refs(repo);
            
            process.env.COMMIT = commit;
            process.env.REPO = repo;
            
            procs('git', [ 'clone', p.repodir, dir ])
                .then('git', [ 'checkout', commit ], { cwd : dir })
                .on('exit', function respawn () {
                    emit('spawn', cmd, args, { cwd : dir });
                    self.emit('spawn', cmd, args, { cwd : dir }, repo, commit);
                    
                    var ps = spawn(cmd, args, { cwd : dir });
                    ps.stdout.on('data', function (buf) {
                        emit('data', buf.toString());
                        self.emit('stdout', buf, repo, commit);
                    });
                    
                    ps.stderr.on('data', function (buf) {
                        emit('data', buf.toString());
                        self.emit('stdout', buf, repo, commit);
                    });
                    
                    ps.on('exit', function (code, sig) {
                        emit('exit', code, sig);
                        self.emit('exit', code, sig, repo, commit);
                        setTimeout(respawn, 1000);
                    });
                })
            ;
        });
    });
    
    return self;
};
