#!/usr/bin/env node
var argv = require('optimist').argv;
var propagit = require('../');
var spawn = require('child_process').spawn;
var path = require('path');

var cmd = argv._[0];

if (cmd === 'drone') {
    var hub = parseAddr(argv.hub);
    var command = argv._.slice(1);
    
    var drone = propagit(argv).drone(hub, command);
    
    drone.on('error', function (err) {
        console.error(err && err.stack || err);
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
    var hub = parseAddr(argv.hub);
    var deploy = propagit(argv).deploy(hub, repo, commit);
    deploy.pipe(process.stdout);
    deploy.on('end', process.exit);
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
