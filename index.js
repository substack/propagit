var dnode = require('dnode');
var upnode = require('upnode');
var pushover = require('pushover');
var mkdirp = require('mkdirp');

var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

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
    this.secret = opts.secret;
    
    var base = opts.basedir || process.cwd();
    this.repodir = path.resolve(opts.repodir || base + '/repos');
    this.deploydir = path.resolve(opts.deploydir || base + '/deploy');
}

Propagit.prototype = new EventEmitter;

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
        this.spawn = function (cmd, args, emit, opts) {
            self.emit('spawn', cmd, args, emit, opts);
        };
        
        this.fetch = function (repo, emit) {
            self.emit('fetch', repo, emit);
        };
        
        this.deploy = function (repo, commit, emit) {
            self.emit('deploy', repo, commit, emit);
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
                
                var res = {
                    ports : {
                        control : controlPort,
                        git : gitPort,
                    },
                };
                if (remote.role !== 'drone') {
                    res.deploy = function () {
                        var args = [].slice.call(arguments);
                        self.drones.forEach(function (drone) {
                            drone.deploy.apply(null, args);
                        });
                    };
                    res.spawn = function () {
                        var args = [].slice.call(arguments);
                        self.drones.forEach(function (drone) {
                            drone.spawn.apply(null, args);
                        });
                    };
                }
                cb(null, res);
                
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
};

Propagit.prototype.deploy = function (hub, repo, commit, cmd, emit) {
    var self = this;
    dnode.connect(hub.host, hub.port, function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) { 
                console.error(err);
                conn.end();
            }
            else res.deploy(repo, commit, function (name) {
                if (name === 'end') {
                    if (cmd) res.spawn(cmd[0], cmd.slice(1), emit, {
                        repo : repo,
                        commit : commit,
                    });
                    else conn.end();
                }
            });
        });
    });
};
