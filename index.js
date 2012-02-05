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
    
    if (opts.hub) this.connect(opts.hub);
}

Propagit.prototype = new Stream;

Propagit.prototype.connect = function (hub) {
    var self = this;
    
    if (typeof hub === 'string') {
        hub = {
            host : hub.split(':')[0],
            port : hub.split(':')[1],
        };
    }
    
    var uid = (Math.random() * Math.pow(16,8)).toString(16);
    var inst = upnode(function (remote, conn) {
        this.name = uid;
    });
    
    self.hub = inst.connect(hub, function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) self.emit('error', err)
            else {
                self.ports = res.ports;
                self.gitUri = 'http://' + hub.host + ':' + self.ports.git;
                conn.emit('up', res);
            };
        });
    });
    
    [ 'up', 'reconnect', 'down' ].forEach(function (name) {
        self.hub.on(name, self.emit.bind(self, name));
    });
    
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
                cb(null, self.createService(remote, conn));
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

Propagit.prototype.getDrones = function (opts) {
    var self = this;
    if (!opts) opts = {};
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
};

Propagit.prototype.createService = function (remote, conn) {
    var self = this;
    
    var service = { ports : self.ports };
    
    service.drones = function (cb) {
        if (typeof cb !== 'function') return;
        cb(self.drones.map(function (d) { return d.name }));
    };
    
    service.deploy = function (opts, cb) {
        self.getDrones(opts).forEach(function (drone) {
            self.emit('deploy', drone.name, opts);
            drone.deploy(opts, cb);
        });
    };
    
    service.spawn = function (opts, cb) {
        self.getDrones(opts).forEach(function (drone) {
            self.emit('spawn', drone.name, opts);
            drone.spawn(opts, cb);
        });
    };
    
    service.register = function (role, obj) {
        if (role === 'drone') {
            self.drones.push(obj);
            
            conn.on('end', function () {
                var ix = self.drones.indexOf(obj);
                if (ix >= 0) self.drones.splice(ix, 1);
            });
            
            if (typeof obj.fetch !== 'function') return;
            
            fs.readdir(self.repodir, function (err, repos) {
                if (err) console.error(err)
                else repos.forEach(function (repo) {
                    obj.fetch(repo, logger(obj.name));
                });
            });
        }
    };
    
    return service;
};

Propagit.prototype.drone = function () {
    var self = this;
    
    mkdirp(self.deploydir);
    mkdirp(self.repodir);
    
    self.processes = {};
    
    function refs (repo) {
        return {
            origin : self.gitUri + '/' + repo,
            repodir : path.join(self.repodir, repo + '.git'),
        }
    }
    self.on('error', self.emit.bind(self, 'error'));
    
    var actions = {};
    
    actions.fetch = function (repo, emit) {
        var p = refs(repo);
        procs('git', [ 'init', '--bare', p.repodir ])
            .then('git', [ 'fetch', p.origin ], { cwd : p.repodir })
        ;
    };
    
    actions.deploy = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        var dir = path.join(self.deploydir, repo + '.' + commit);
        var p = refs(repo);
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        spawn('git', [ 'clone', p.repodir, dir ])
            .on('exit', function (code, sig) {
                if (code) cb(code, sig)
                else spawn('git', [ 'checkout', commit ], { cwd : dir })
                    .on('exit', function (code, sig) {
                        cb(code, sig)
                    })
                ;
            })
        ;
    };
    
    actions.stop = function (id, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var proc = self.processes[id];
        if (!proc) cb('no such process')
        else {
            proc.status = 'stopped';
            proc.process.kill();
            cb();
        }
    };
    
    actions.restart = function (id, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var proc = self.processes[id];
        if (!proc) cb('no such process')
        else {
            if (proc.status === 'stopped') proc.respawn()
            else proc.process.kill()
        }
    };
    
    actions.ps = function (cb) {
        cb(Object.keys(self.processes).reduce(function (acc, id) {
            var proc = self.processes[id];
            acc[id] = {
                scrollback : function (i, j, fn) {
                    if (typeof fn !== 'function') return;
                    fn(proc.scrollback.slice(-j, -i));
                },
                status : proc.status,
            };
            return acc;
        }, {}));
    };
    
    actions.spawn = function (opts, emit) {
        var repo = opts.repo;
        var commit = opts.commit;
        var dir = path.join(self.deploydir, repo + '.' + commit);
        opts.directory = dir;
        
        var cmd = opts.command[0];
        var args = opts.command.slice(1);
        
        var id = Math.floor(Math.random() * (1<<24)).toString(16);
        
        var processes = self.processes;
        (function respawn () {
            var ps = spawn(cmd, args, { cwd : dir });
            var proc = self.processes[id] = {
                status : 'running',
                process : ps,
                scrollback : { size : 0, buffers : [] },
                respawn : respawn,
            };
            
            function record (buf) {
                var sb = proc.scrollback;
                sb.buffers.push(buf);
                sb.size += buf.length;
                var max = opts.scrollback || 4096; 
                
                while (sb.size > max && sb.buffers.length) {
                    sb.size -= sb.buffers.shift().length;
                }
            }
            
            ps.stdout.on('data', function (buf) {
                if (emit) emit('data', buf.toString());
                self.emit('stdout', buf, opts);
                record(buf);
            });
            
            ps.stderr.on('data', function (buf) {
                if (emit) emit('data', buf.toString());
                self.emit('stderr', buf, opts);
                record(buf);
            });
            
            ps.once('exit', function (code, sig) {
                if (emit) emit('exit', code, sig);
                self.emit('exit', code, sig, opts);
                if (proc.status !== 'stopped') {
                    proc.status = 'respawning';
                    setTimeout(respawn, 1000);
                }
            });
            
            if (emit) emit('spawn', id, opts);
            self.emit('spawn', id, opts);
        })();
    };
    
    function onup (remote) {
        remote.register('drone', actions);
    }
    self.hub(onup);
    self.hub.on('down', function () {
        self.hub.once('up', onup);
    });
    
    
    return self;
};

Propagit.prototype.stop = function (opts, id) {
    var self = this;
    
    if (typeof opts === 'string') {
        id = opts;
        opts = undefined;
    }
    
    var stream = new Stream;
    stream.readable = true;
    
    (opts ? self.getDrones(opts) : self.drones).forEach(function (drone) {
        drone.stop(id, stream.emit.bind(stream));
    });
    
    return stream;
};

Propagit.prototype.spawn = function (opts) {
    var self = this;
    
    var stream = new Stream;
    stream.readable = true;
    
    self.hub(function (hub) {
        hub.spawn(opts, stream.emit.bind(stream));
    });
    
    return stream;
};

Propagit.prototype.deploy = function (opts) {
    var self = this;
    
    var stream = new Stream;
    stream.readable = true;
    
    self.hub(function (hub) {
        hub.deploy(opts, stream.emit.bind(stream));
    });
    
    return stream;
};
