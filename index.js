var upnode = require('upnode');
var pushover = require('pushover');
var mkdirp = require('mkdirp');
var spawn = require('child_process').spawn;

var createWebServer = require('./lib/web');

var fs = require('fs');
var path = require('path');
var Stream = require('stream').Stream;

var exists = fs.exists || path.exists;

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
    this.secret = opts.secret || '';
    this.middleware = [];
    
    var base = opts.basedir || process.cwd();
    this.repodir = path.resolve(opts.repodir || base + '/repos');
    this.deploydir = path.resolve(opts.deploydir || base + '/deploy');
    this.name = opts.name || (Math.random() * Math.pow(16,8)).toString(16);
    
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
    
    self.hub = upnode.connect(hub, function (remote, conn) {
        var auth = self.secret && 'git:' + encodeURIComponent(self.secret);
        
        remote.auth(self.secret, function (err, res) {
            if (err) self.emit('error', err)
            else {
                self.ports = res.ports;
                self.gitUri = 'http://'
                    + (self.secret ? auth + '@' : '')
                    + hub.host + ':' + self.ports.git
                ;
                conn.emit('up', res);
            };
        });
    });
    
    [ 'up', 'reconnect', 'down' ].forEach(function (name) {
        self.hub.on(name, self.emit.bind(self, name));
    });
    
    return self;
};

Propagit.prototype.use = function (fn) {
    this.middleware.push(fn);
};

Propagit.prototype.listen = function (controlPort, gitPort) {
    var self = this;
    mkdirp(self.repodir);
    self.drones = [];
    self.ports = {
        control : controlPort,
        git : gitPort,
    };
    
    var server = upnode(function (remote, conn) {
        this.auth = function (secret, cb) {
            if (typeof cb !== 'function') return
            else if (self.secret === secret) {
                cb(null, self.createService(remote, conn));
            }
            else cb('ACCESS DENIED')
        };
    }).listen(controlPort);
    
    if (!self._servers) self._servers = [];
    self._servers.push(server);
    
    self.close = function () {
        self._servers.forEach(function (s) {
            s.close();
        });
    };
    
    var repos = self.repos = pushover(self.repodir);
    repos.on('push', function (repo) {
        self.emit('push', repo);
        self.drones.forEach(function (drone) {
            drone.fetch(repo, logger(drone.id));
        });
    });
    createWebServer(repos, self.secret).listen(gitPort);
    
    return self;
};

Propagit.prototype.getDrones = function (opts) {
    var self = this;
    if (!opts) opts = {};
    if (opts.drone === '*') opts.drone = { test : function () { return true } };
    
    var names = opts.drone ? [ opts.drone ] : opts.drones;
    var ids = self.drones.map(function (d) { return d.id });
    
    if (opts.drone && typeof opts.drone.test === 'function') {
        return self.drones.filter(function (d) {
            return opts.drone.test(d.id);
        });
    }
    if (Array.isArray(names) && names.length) {
        return names.map(function (name) {
            var ix = ids.indexOf(name);
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
        cb(self.drones.map(function (d) { return d.id }));
    };
    
    service.ps = function (emit) {
        var drones = self.drones;
        var pending = drones.length;
        if (pending === 0) emit('end')
        
        drones.forEach(function (drone) {
            drone.ps(function (ps) {
                emit('data', drone.id, ps);
                if (--pending === 0) emit('end');
            });
        });
    };
    
    service.deploy = function (opts, cb) {
        if (!opts.drone) opts.drone = '*';
        
        var drones = self.getDrones(opts);
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var errors = [];
        
        drones.forEach(function (drone) {
            self.emit('deploy', drone.id, opts);
            drone.fetch(opts.repo, function (err) {
                pending --;
                
                if (err) {
                    errors.push(
                        'Error fetching from drone ' + drone.id + ':\n'
                        + err
                    );
                    if (pending === 0) cb(errors.length && errors);
                }
                else drone.deploy(opts, function (err) {
                    if (err) {
                        errors.push(
                            'Error deploying to drone ' + drone.id + ':\n'
                            + err
                        );
                    }
                    if (pending === 0) cb(errors.length && errors);
                })
            });
        });
    };
    
    service.spawn = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var procs = {};
        drones.forEach(function (drone) {
            if (!opts.env) opts.env = {};
            if (!opts.env.DRONE_ID) opts.env.DRONE_ID = drone.id;
            
            drone.spawn(opts, function (pid) {
                var opts_ = {};
                Object.keys(opts).forEach(function (key) {
                    opts_[key] = opts[key];
                });
                opts_.drone = drone.id;
                opts_.id = pid;
                
                procs[drone.id] = pid;
                if (--pending === 0) cb(null, procs);
            });
        });
    };
    
    service.stop = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb(null, [])
        var procs = {};
        if (!Array.isArray(opts.pid)) opts.pid = [ opts.pid ];
        
        drones.forEach(function (drone) {
            drone.stop(opts.pid, function (pids) {
                procs[drone.id] = pids;
                if (--pending === 0) cb(null, procs);
            });
        });
    };
    
    service.register = function (role, obj) {
        if (role === 'drone') {
            if (typeof obj !== 'object') return;
            obj.id = String(obj.id);
            var ids = self.drones.map(function (d) { return d.id });
            
            while (ids.indexOf(obj.id) >= 0) {
                obj.id = obj.id.replace(/(?:-(\d+))?$/, function (_, x) {
                    return '-' + (parseInt(x || '0', 10) + 1);
                });
            }
            
            self.drones.push(obj);
            
            conn.on('end', function () {
                var ix = self.drones.indexOf(obj);
                if (ix >= 0) self.drones.splice(ix, 1);
            });
            
            if (typeof obj.fetch !== 'function') return;
            
            fs.readdir(self.repodir, function (err, repos) {
                if (err) console.error(err)
                else repos.forEach(function (repo) {
                    obj.fetch(repo, logger(obj.id));
                });
            });
        }
    };
    
    self.middleware.forEach(function (m) {
        m(service, conn);
    });
    
    return service;
};

Propagit.prototype.drone = function (fn) {
    var self = this;
    
    mkdirp(self.deploydir);
    mkdirp(self.repodir);
    
    self.processes = {};
    
    function refs (repo) {
        return {
            origin : (self.gitUri + '/' + repo)
                .replace(/(\.git)*$/, '.git')
            ,
        }
    }
    self.on('error', self.emit.bind(self, 'error'));
    
    var actions = {};
    
    actions.fetch = function (repo, cb) {
        var p = refs(repo);
        runCmd([ 'git', 'init', self.repodir ], function (err) {
            if (err) return cb(err);
            runCmd([ 'git', 'fetch', p.origin ], { cwd : self.repodir }, cb);
        });
    };
    
    actions.deploy = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        var dir = path.join(self.deploydir, repo + '.' + commit);
        exists(dir, function (ex) {
            if (ex) return cb(null, false); // already deployed this commit
            
            var p = refs(repo);
            
            process.env.COMMIT = commit;
            process.env.REPO = repo;
            
            runCmd([ 'git', 'clone', self.repodir, dir ], function (err) {
                if (err) return cb(err);
                
                runCmd([ 'git', 'checkout', commit ], { cwd : dir },
                function (err) {
                    if (err) return cb(err);
                    self.emit('deploy', {
                        drone : actions.id,
                        commit : commit,
                        repo : repo,
                        cwd : dir,
                    });
                    cb(null, true)
                });
            });
        });
    };
    
    actions.stop = function (ids, cb) {
        if (typeof cb !== 'function') cb = function () {};
        if (!Array.isArray(ids)) ids = [ ids ];
        cb(ids.filter(function (id) {
            var proc = self.processes[id];
            if (!proc) return false;
            self.emit('stop', { drone : actions.id, id : id });
            
            proc.status = 'stopped';
            proc.process.kill();
            delete self.processes[id];
            
            return true;
        }));
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
                status : proc.status,
                repo : proc.repo,
                commit : proc.commit,
                command : proc.command,
            };
            return acc;
        }, {}));
    };
    
    actions.spawn = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        var id = Math.floor(Math.random() * (1<<24)).toString(16);
        process.env.PROCESS_ID = id;
        
        Object.keys(opts.env || {}).forEach(function (key) {
            process.env[key] = opts.env[key];
        });
        
        var dir = opts.cwd || path.join(self.deploydir, repo + '.' + commit);
        
        var cmd = opts.command[0];
        var args = opts.command.slice(1);
        
        var processes = self.processes;
        (function respawn () {
            var ps = spawn(cmd, args, { cwd : dir });
            var proc = self.processes[id] = {
                status : 'running',
                repo : repo,
                commit : commit,
                command : opts.command,
                cwd : dir,
                process : ps,
                respawn : respawn,
                drone : actions.id,
            };
            
            ps.stdout.on('data', function (buf) {
                self.emit('stdout', buf, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                });
            });
            
            ps.stderr.on('data', function (buf) {
                self.emit('stderr', buf, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                });
            });
            
            ps.once('exit', function (code, sig) {
                self.emit('exit', code, sig, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                    command : opts.command,
                });
                
                if (opts.once) {
                    delete self.processes[id];
                }
                else if (proc.status !== 'stopped') {
                    proc.status = 'respawning';
                    setTimeout(function () {
                        if (proc.status !== 'stopped') respawn();
                    }, 1000);
                }
            });
            
            self.emit('spawn', {
                drone : actions.id,
                id : id,
                repo : repo,
                commit : commit,
                command : opts.command,
                cwd : dir,
            });
        })();
        
        cb(id);
    };
    
    actions.id = self.name;
    if (typeof fn === 'function') fn.call(self, actions);
    
    self.middleware.forEach(function (m) {
        m(actions);
    });
    
    function onup (remote) {
        remote.register('drone', actions);
    }
    self.hub(onup);
    self.hub.on('down', function () {
        self.hub.once('up', onup);
    });
    
    return self;
};

Propagit.prototype.stop = function (opts, cb) {
    var self = this;
    
    stream.readable = true;
    
    (opts ? self.getDrones(opts) : self.drones).forEach(function (drone) {
        drone.stop(opts.pid, cb);
    });
    
    return self;
};

Propagit.prototype.spawn = function (opts) {
    var self = this;
    
    self.hub(function (hub) {
        hub.spawn(opts, function () {
            self.emit('spawn');
        });
    });
    
    return self;
};

Propagit.prototype.deploy = function (opts, cb) {
    var self = this;
    
    self.hub(function (hub) {
        hub.deploy(opts, function (err) {
            if (err) return cb && cb(err);
            
            self.emit('deploy');
            if (cb) cb();
        });
    });
    
    return self;
};

Propagit.prototype.ps = function () {
    var self = this;
    var stream = new Stream;
    self.hub(function (hub) {
        hub.ps(stream.emit.bind(stream));
    });
    return stream;
};

function runCmd (cmd, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    
    var ps = spawn(cmd[0], cmd.slice(1), opts);
    var data = '';
    ps.stdout.on('data', function (buf) { data += buf });
    ps.stderr.on('data', function (buf) { data += buf });
    
    var code, sig;
    var pending = 3;
    function onend () {
        if (--pending !== 0) return;
        
        if (code) {
            cb([
                'Exited with code ' + code + ':',
                'Command: ' + cmd.join(' '),
                data
            ].join('\n'))
        }
        else cb(null)
    }
    
    ps.on('exit', function (c, s) {
        code = c, sig = s;
    });
    ps.on('exit', onend);
    ps.stdout.on('end', onend);
    ps.stderr.on('end', onend);
}
