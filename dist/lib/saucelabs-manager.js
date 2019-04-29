'use strict';

var request = require('request'),
    log = require('./log'),
    _ = require('underscore');

/**
 * SessionManager Constructor
 *
 * @param {Object} options
 * @api public
 */
function SauceLabsSessionManager(options) {

  log.debug('[chimp][saucelabs-session-manager] options are', options);

  var host = options.host.replace('ondemand.', '');
  var sauceLabsBaseUrl = 'https://' + options.user + ':' + options.key + '@' + host + '/rest/v1/' + options.user;
  options.sauceLabsUrl = sauceLabsBaseUrl;

  this.options = options;

  this.maxRetries = 30;
  this.retryDelay = 3000;
  this.retry = 0;

  this.buildName = null;

  log.debug('[chimp][saucelabs-session-manager] created a new SessionManager', options);
}

SauceLabsSessionManager.prototype.webdriver = require('xolvio-sync-webdriverio');

/**
 * Wraps the webdriver remote method and allows reuse options
 *
 * @api public
 */
SauceLabsSessionManager.prototype.remote = function (webdriverOptions, callback) {

  var self = this;

  log.debug('[chimp][saucelabs-session-manager] creating webdriver remote ');
  var browser = this.webdriver.remote(webdriverOptions);

  this.buildName = webdriverOptions.desiredCapabilities.build;
  log.debug('[chimp][saucelabs-session-manager] BuildName: ' + this.buildName);

  callback(null, browser);
  return;
};

var DEFAULT_LIMIT = 100;

/**
 * Gets a list of sessions from the SauceLabs API based on Build ID
 *
 * @api private
 */
SauceLabsSessionManager.prototype._getJobs = function (callback, limit, skip) {
  var hub = this.options.sauceLabsUrl + '/jobs?full=true&limit=' + limit;
  if (skip > 0) {
    hub += '&skip=' + skip;
  }

  log.debug('[chimp][saucelabs-session-manager]', 'requesting sessions from', hub);

  request(hub, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      log.debug('[chimp][saucelabs-session-manager]', 'received data', body);
      callback(null, JSON.parse(body));
    } else {
      log.error('[chimp][saucelabs-session-manager]', 'received error', error);
      callback(error);
    }
  });
};

/**
 * @api public
 */
SauceLabsSessionManager.prototype.killCurrentSession = function (callback) {

  var self = this;
  var killSession = function (job) {
    // This will stop the session, causing a 'User terminated' error.
    // If we don't manually stop the session, we get a timed-out error.
    var options = {
      url: this.options.sauceLabsUrl + '/jobs/' + job.id + '/stop',
      method: 'PUT'
    };

    request(options, function (error, response) {
      if (!error && response.statusCode === 200) {
        log.debug('[chimp][saucelabs-session-manager]', 'stopped session');
        callback();
      } else {
        log.error('[chimp][saucelabs-session-manager]', 'received error', error);
        callback(error);
      }
    });

    // This will set the session to passing or else it will show as Errored out
    // even though we stop it.
    options = {
      url: this.options.sauceLabsUrl + '/jobs/' + job.id,
      method: 'PUT',
      json: true,
      body: { passed: true }
    };

    request(options, function (error, response) {
      if (!error && response.statusCode === 200) {
        log.debug('[chimp][saucelabs-session-manager]', 'updated session to passing state');
        callback();
      } else {
        log.error('[chimp][saucelabs-session-manager]', 'received error', error);
        callback(error);
      }
    });
  }.bind(this);

  var getJobForBuildName = function (cb, skip) {
    if (!self.buildName) {
      // get one and kill it, this is the (flawed) default of chimp which will just randomly
      // terminate sessions and you get an odd `Error: The test with session id XXX has already finished, and can't receive further commands.` error
      console.warn('You should really consider setting a buildName, otherwise random sessions will be terminated!');
      this._getJobs(function (err, jobs) {
        if (jobs.length) {
          killSession(jobs[0]);
        }
      }, 1);
      return;
    }
    this._getJobs(function (err, jobs) {
      console.log('jobs', jobs);
      // the original code never uses this error,
      // probably because if we don't find anything we just leave the session alone
      // we might want to revisit this behavior
      // if (err) {
      //   cb(err);
      // }
      if (!jobs.length) {
        // no more jobs found, let's exit
        callback();
        return;
      }
      var currentJobs = _.find(jobs, function (b) {
        return b.automation_build.name === self.buildName;
      });
      if (!currentJobs.length) {
        // maybe it's in the next batch?
        getJobForBuildName(cb, skip + DEFAULT_LIMIT);
      }
    }, DEFAULT_LIMIT, skip);
  }.bind(this);

  getJobForBuildName(killSession, 0);
};

module.exports = SauceLabsSessionManager;