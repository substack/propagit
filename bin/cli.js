#!/usr/bin/env node
var argv = require('optimist').argv;
var propagit = require('../');
var spawn = require('child_process').spawn;
var path = require('path');

var cmd = argv._[0];

if (cmd === 'drone') {
    var drone = propagit(argv).drone();
    
    drone.on('error', function (err) {
        console.error(err && err.stack || err);
    });
    
    drone.on('spawn', function (id, opts) {
        console.log(
            '[' + opts.repo + '.' + opts.commit.slice(8) + '] '
            + opts.command.join(' ')
        );
    });
    
    drone.on('exit', function (code, sig, opts) {
        console.error([
            '[' + opts.repo + '.' + opts.commit.slice(8) + ']',
            opts.command.join(' '),
            'exited with code', code,
            'from', sig,
        ].join(' '));
    });
    
    drone.on('stdout', function (buf, opts) {
        console.log('['
            + opts.repo + '.' + opts.commit.slice(8)
        + '] ' + buf);
    });
    
    drone.on('stderr', function (buf, opts) {
        console.log('['
            + opts.repo + '.' + opts.commit.slice(8)
        + '] ' + buf);
    });
    
    drone.on('up', function (err) {
        console.log('connected to the hub');
    });
    
    drone.on('reconnect', function (err) {
        console.log('reconnecting to the hub');
    });
    
    drone.on('down', function (err) {
        console.log('disconnected from the hub');
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
    
    var deploy = propagit(argv).deploy({
        repo : repo,
        commit : commit,
    });
    deploy.on('deploy', function () {
        deploy.hub.close();
    });
}
else if (cmd === 'spawn') {
    var repo = argv._[1];
    var commit = argv._[2];
    var command = argv._.slice(3);
    
    var s = propagit(argv).spawn({
        repo : repo,
        commit : commit,
        command : command,
        env : argv.env || {},
    });
    s.on('spawn', function () {
        s.hub.close();
    });
}
else if (cmd === 'ps') {
    var p = propagit(argv);
    var s = p.ps();
    
    s.on('data', function (name, proc) {
        console.dir([ name, proc ]);
    });
    
    s.on('end', function () {
        p.hub.close();
    });
}
else {
    console.log([
        'Usage:',
        '  propagit OPTIONS hub',
        '',
        '    Create a server to coordinate drones.',
        '',
        '    --port       port to listen on',
        '    --secret     password to use',
        '    --basedir    directory to put repositories',
        '',
        '  propagit OPTIONS drone',
        '',
        '    Listen to the hub for deploy events and execute COMMAND with',
        '    environment variables $REPO and $COMMIT on each deploy.',
        '',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
        '    --basedir    directory to put repositories and deploys in',
        '',
        '  propagit OPTIONS deploy REPO COMMIT [COMMAND...]',
        '',
        '    Deploy COMMIT to all of the drones listening to the hub.',
        '',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
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
