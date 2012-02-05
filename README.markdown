propagit
========

Cascading multi-server git deployment.

[![build status](https://secure.travis-ci.org/substack/propagit.png)](http://travis-ci.org/substack/propagit)

example
=======

First start up a hub server to listen for git deploys:

    $ propagit hub --port=6000 --secret=beepboop
    control service listening on :6000
    git service listening on :6001

then spin up as many drones as necessary on other machines
with the command to run on deployment for each type of service:

    $ propagit drone --hub=hubhost:6000 --secret=beepboop

Now you can `git push` to the hub and the drones will `git fetch` from the hub.
Just do:

    $ cd ~/projects/somerepo
    $ git push http://hubhost:6001/somerepo master

First deploy the code to a fresh deploy directory for the given repo name and
commit hash:

    $ propagit deploy --hub=hubhost:6000 --secret=beepboop \
      somerepo ed56c6e85731d412fe22cf437cb63130afc34b07

then spawn processes for that deployment:

    $ propagit spawn --hub=hubhost:6000 --secret=beepboop \
      somerepo ed56c6e85731d412fe22cf437cb63130afc34b07 \
      -- node server.js 8085

usage
=====

```
Usage:
  propagit OPTIONS hub

    Create a server to coordinate drones.

    --port       port to listen on
    --secret     password to use
    --basedir    directory to put repositories

  propagit OPTIONS drone

    Listen to the hub for deploy events to execute commands with
    environment variables $REPO and $COMMIT set on each deploy.
 
    --hub        connect to the hub host:port
    --secret     password to use
    --basedir    directory to put repositories and deploys in
  
  propagit OPTIONS deploy REPO COMMIT
  
    Deploy COMMIT to all of the drones listening to the hub.

    --hub        connect to the hub host:port
    --secret     password to use
  
  propagit OPTIONS spawn REPO COMMIT [COMMAND...]
  
    Run COMMAND on all the drones specified by OPTIONS.

  propagit OPTIONS ps
  
    List all the running processes on all the drones.
```

install
=======

With [npm](http://npmjs.org) do:

    npm install -g propagit
