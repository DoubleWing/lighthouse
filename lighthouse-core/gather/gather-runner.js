/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const log = require('lighthouse-logger');
const LHError = require('../lib/errors');
const URL = require('../lib/url-shim');
const NetworkRecorder = require('../lib/network-recorder.js');
const constants = require('../config/constants');

const Driver = require('../gather/driver.js'); // eslint-disable-line no-unused-vars

/**
 * @typedef {{driver: Driver, url: string, settings: LH.Config.Settings}} GatherRunnerOptions
 */
/**
 * @typedef {{LighthouseRunWarnings: Array<Array<string>>}} SpecializedResults
 * @typedef {{[A in keyof LH.Artifacts]: Array<LH.Artifacts[A] | Promise<LH.Artifacts[A]>>}} ArtifactResults
 */
/**
 * Each entry in each gatherer result array is the output of a gatherer phase:
 * `beforePass`, `pass`, and `afterPass`. Flattened into an `LH.Artifacts` in
 * `collectArtifacts`.
 * @typedef {SpecializedResults & ArtifactResults} GathererResults
 */

/**
 * Class that drives browser to load the page and runs gatherer lifecycle hooks.
 * Execution sequence when GatherRunner.run() is called:
 *
 * 1. Setup
 *   A. navigate to about:blank
 *   B. driver.connect()
 *   C. GatherRunner.setupDriver()
 *     i. assertNoSameOriginServiceWorkerClients
 *     ii. beginEmulation
 *     iii. enableRuntimeEvents
 *     iv. evaluateScriptOnLoad rescue native Promise from potential polyfill
 *     v. register a performance observer
 *     vi. register dialog dismisser
 *     vii. clearDataForOrigin
 *
 * 2. For each pass in the config:
 *   A. GatherRunner.beforePass()
 *     i. navigate to about:blank
 *     ii. Enable network request blocking for specified patterns
 *     iii. all gatherers' beforePass()
 *   B. GatherRunner.pass()
 *     i. cleanBrowserCaches() (if it's a perf run)
 *     ii. beginDevtoolsLog()
 *     iii. beginTrace (if requested)
 *     iv. GatherRunner.loadPage()
 *       a. navigate to options.url (and wait for onload)
 *     v. all gatherers' pass()
 *   C. GatherRunner.afterPass()
 *     i. endTrace (if requested) & endDevtoolsLog & endThrottling
 *     ii. all gatherers' afterPass()
 *
 * 3. Teardown
 *   A. GatherRunner.disposeDriver()
 *   B. collect all artifacts and return them
 *     i. collectArtifacts() from completed passes on each gatherer
 *     ii. add trace data and computed artifact methods
 */
class GatherRunner {
  /**
   * Loads about:blank and waits there briefly. Since a Page.reload command does
   * not let a service worker take over, we navigate away and then come back to
   * reload. We do not `waitForLoad` on about:blank since a page load event is
   * never fired on it.
   * @param {Driver} driver
   * @param {string=} url
   * @param {number=} duration
   * @return {Promise<void>}
   */
  static async loadBlank(
      driver,
      url = constants.defaultPassConfig.blankPage,
      duration = constants.defaultPassConfig.blankDuration
  ) {
    await driver.gotoURL(url);
    await new Promise(resolve => setTimeout(resolve, duration));
  }

  /**
   * Loads options.url with specified options. If the main document URL
   * redirects, options.url will be updated accordingly. As such, options.url
   * will always represent the post-redirected URL. options.initialUrl is the
   * pre-redirect starting URL.
   * @param {Driver} driver
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<void>}
   */
  static async loadPage(driver, passContext) {
    const finalUrl = await driver.gotoURL(passContext.url, {
      waitForLoad: true,
      passContext,
    });
    passContext.url = finalUrl;
  }

  /**
   * @param {Driver} driver
   * @param {GathererResults} gathererResults
   * @param {GatherRunnerOptions} options
   * @return {Promise<void>}
   */
  static async setupDriver(driver, gathererResults, options) {
    log.log('status', 'Initializing…');

    await driver.assertNoSameOriginServiceWorkerClients(options.url);
    const userAgent = await driver.getUserAgent();
    GatherRunner.warnOnHeadless(userAgent, gathererResults);
    gathererResults.UserAgent = [userAgent];

    // Enable emulation based on settings
    await driver.beginEmulation(options.settings);
    await driver.enableRuntimeEvents();
    await driver.cacheNatives();
    await driver.registerPerformanceObserver();
    await driver.dismissJavaScriptDialogs();

    const resetStorage = !options.settings.disableStorageReset;
    if (resetStorage) await driver.clearDataForOrigin(options.url);
  }

  /**
   * @param {Driver} driver
   * @return {Promise<void>}
   */
  static async disconnectDriver(driver) {
    log.log('status', 'Disconnecting from browser...');
    try {
      await driver.disconnect();
    } catch (err) {
      // Ignore disconnecting error if browser was already closed.
      // See https://github.com/GoogleChrome/lighthouse/issues/1583
      if (!(/close\/.*status: 500$/.test(err.message))) {
        log.error('GatherRunner disconnect', err.message);
      }
    }
  }

  /**
   * Test any error output from the promise, absorbing non-fatal errors and
   * throwing on fatal ones so that run is stopped.
   * @param {Promise<*>} promise
   * @return {Promise<void>}
   */
  static recoverOrThrow(promise) {
    return promise.catch(err => {
      if (err.fatal) {
        throw err;
      }
    });
  }

  /**
   * Returns an error if the original network request failed or wasn't found.
   * @param {string} url The URL of the original requested page.
   * @param {Array<LH.WebInspector.NetworkRequest>} networkRecords
   * @return {LHError|undefined}
   */
  static getPageLoadError(url, networkRecords) {
    const mainRecord = networkRecords.find(record => {
      // record.url is actual request url, so needs to be compared without any URL fragment.
      return URL.equalWithExcludedFragments(record.url, url);
    });

    let errorCode;
    let errorReason;
    if (!mainRecord) {
      errorCode = LHError.errors.NO_DOCUMENT_REQUEST;
    } else if (mainRecord.failed) {
      errorCode = LHError.errors.FAILED_DOCUMENT_REQUEST;
      errorReason = mainRecord.localizedFailDescription;
    }

    if (errorCode) {
      // @ts-ignore TODO(bckenny): fix LHError constructor/errors mismatch
      const error = new LHError(errorCode, {reason: errorReason});
      log.error('GatherRunner', error.message, url);
      return error;
    }
  }

  /**
   * Add run warning if running in Headless Chrome.
   * @param {string} userAgent
   * @param {GathererResults} gathererResults
   */
  static warnOnHeadless(userAgent, gathererResults) {
    const chromeVersion = userAgent.split(/HeadlessChrome\/(.*) /)[1];
    // Headless Chrome gained throttling support in Chrome 63.
    // https://chromium.googlesource.com/chromium/src/+/8931a104b145ccf92390f6f48fba6553a1af92e4
    const minVersion = '63.0.3239.0';
    if (chromeVersion && chromeVersion < minVersion) {
      gathererResults.LighthouseRunWarnings[0].push('Your site\'s mobile performance may be ' +
          'worse than the numbers presented in this report. Lighthouse could not test on a ' +
          'mobile connection because Headless Chrome does not support network throttling ' +
          'prior to version ' + minVersion + '. The version used was ' + chromeVersion);
    }
  }

  /**
   * Navigates to about:blank and calls beforePass() on gatherers before tracing
   * has started and before navigation to the target page.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise<void>}
   */
  static async beforePass(passContext, gathererResults) {
    const blockedUrls = (passContext.passConfig.blockedUrlPatterns || [])
      .concat(passContext.settings.blockedUrlPatterns || []);
    const blankPage = passContext.passConfig.blankPage;
    const blankDuration = passContext.passConfig.blankDuration;

    await GatherRunner.loadBlank(passContext.driver, blankPage, blankDuration);
    // Set request blocking before any network activity
    // No "clearing" is done at the end of the pass since blockUrlPatterns([]) will unset all if
    // neccessary at the beginning of the next pass.
    await passContext.driver.blockUrlPatterns(blockedUrls);
    await passContext.driver.setExtraHTTPHeaders(passContext.settings.extraHeaders);

    for (const gathererDefn of passContext.passConfig.gatherers) {
      const gatherer = gathererDefn.instance;
      // Add gatherer options to the passContext.
      passContext.options = gathererDefn.options || {};

      // Wrap gatherer response in promise, whether rejected or not.
      const artifactPromise = Promise.resolve().then(_ => gatherer.beforePass(passContext));

      gathererResults[gatherer.name] = [artifactPromise];
      await GatherRunner.recoverOrThrow(artifactPromise);
    }
  }

  /**
   * Navigates to requested URL and then runs pass() on gatherers while trace
   * (if requested) is still being recorded.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise<void>}
   */
  static async pass(passContext, gathererResults) {
    const driver = passContext.driver;
    const config = passContext.passConfig;
    const settings = passContext.settings;
    const gatherers = config.gatherers;

    const recordTrace = config.recordTrace;
    const isPerfRun = !settings.disableStorageReset && recordTrace && config.useThrottling;

    const gatherernames = gatherers.map(g => g.instance.name).join(', ');
    const status = 'Loading page & waiting for onload';
    log.log('status', status, gatherernames);

    // Clear disk & memory cache if it's a perf run
    if (isPerfRun) await driver.cleanBrowserCaches();

    // Always record devtoolsLog
    driver.beginDevtoolsLog();

    // Begin tracing if requested by config.
    if (recordTrace) await driver.beginTrace(settings);

    // Navigate.
    await GatherRunner.loadPage(driver, passContext);
    log.log('statusEnd', status);

    for (const gathererDefn of gatherers) {
      const gatherer = gathererDefn.instance;
      // Add gatherer options to the passContext.
      passContext.options = gathererDefn.options || {};

      // Wrap gatherer response in promise, whether rejected or not.
      const artifactPromise = Promise.resolve().then(_ => gatherer.pass(passContext));

      gathererResults[gatherer.name].push(artifactPromise);
      await GatherRunner.recoverOrThrow(artifactPromise);
    }
  }

  /**
   * Ends tracing and collects trace data (if requested for this pass), and runs
   * afterPass() on gatherers with trace data passed in. Promise resolves with
   * object containing trace and network data.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise<LH.Gatherer.LoadData>}
   */
  static async afterPass(passContext, gathererResults) {
    const driver = passContext.driver;
    const config = passContext.passConfig;
    const gatherers = config.gatherers;

    /** @type {LHError|undefined} */
    let pageLoadError;

    let trace;
    if (config.recordTrace) {
      log.log('status', 'Retrieving trace');
      trace = await driver.endTrace();
      log.verbose('statusEnd', 'Retrieving trace');
    }

    const status = 'Retrieving devtoolsLog and network records';
    log.log('status', status);
    const devtoolsLog = driver.endDevtoolsLog();
    const networkRecords = NetworkRecorder.recordsFromLogs(devtoolsLog);
    log.verbose('statusEnd', status);

    pageLoadError = GatherRunner.getPageLoadError(passContext.url, networkRecords);
    // If the driver was offline, a page load error is expected, so do not save it.
    if (!driver.online) pageLoadError = undefined;

    if (pageLoadError) {
      gathererResults.LighthouseRunWarnings[0].push('Lighthouse was unable to reliably load ' +
        'the page you requested. Make sure you are testing the correct URL and that the server ' +
        'is properly responding to all requests.');
    }

    // Expose devtoolsLog and networkRecords to gatherers
    /** @type {LH.Gatherer.LoadData} */
    const passData = {
      networkRecords,
      devtoolsLog,
      trace
    };

    // Disable throttling so the afterPass analysis isn't throttled
    await driver.setThrottling(passContext.settings, {useThrottling: false});

    for (const gathererDefn of gatherers) {
      const gatherer = gathererDefn.instance;
      const status = `Retrieving: ${gatherer.name}`;
      log.log('status', status);

      // Add gatherer options to the passContext.
      passContext.options = gathererDefn.options || {};

      // If there was a pageLoadError, fail every afterPass with it rather than bail completely.
      // Wrap gatherer response in promise, whether rejected or not.
      const artifactPromise = pageLoadError ?
        Promise.reject(pageLoadError) :
        Promise.resolve().then(_ => gatherer.afterPass(passContext, passData));

      gathererResults[gatherer.name].push(artifactPromise);
      await GatherRunner.recoverOrThrow(artifactPromise);
      log.verbose('statusEnd', status);
    }

    // Resolve on tracing data using passName from config.
    return passData;
  }

  /**
   * Takes the results of each gatherer phase for each gatherer and uses the
   * last produced value (that's not undefined) as the artifact for that
   * gatherer. If a non-fatal error was rejected from a gatherer phase,
   * uses that error object as the artifact instead.
   * @param {GathererResults} gathererResults
   * @return {Promise<*>}
   */
  static async collectArtifacts(gathererResults) {
    const artifacts = {};
    /** @type {Array<Error>} */
    const pageLoadFailures = [];

    // Take only unique LighthouseRunWarnings, if any.
    const uniqueWarnings = Array.from(new Set(gathererResults.LighthouseRunWarnings[0]));
    gathererResults.LighthouseRunWarnings = [uniqueWarnings];

    for (const [gathererName, phaseResultsPromises] of Object.entries(gathererResults)) {
      try {
        const phaseResults = await Promise.all(phaseResultsPromises);
        // Take last defined pass result as artifact.
        const definedResults = phaseResults.filter(element => element !== undefined);
        const artifact = definedResults[definedResults.length - 1];
        if (artifact === undefined) {
          throw new Error(`${gathererName} failed to provide an artifact.`);
        }
        artifacts[gathererName] = artifact;
      } catch (err) {
        // To reach this point, all errors are non-fatal, so return err to
        // runner to handle turning it into an error audit.
        artifacts[gathererName] = err;
        // Track page load errors separately, so we can fail loudly if needed.
        if (LHError.isPageLoadError(err)) pageLoadFailures.push(err);
      }
    }

    // Fail the run if more than 50% of all artifacts failed due to page load failure.
    if (pageLoadFailures.length > Object.keys(artifacts).length * 0.5) {
      throw pageLoadFailures[0];
    }

    return artifacts;
  }

  /** @typedef {{traces: Object<string, LH.Trace>, devtoolsLogs: Object<string, Array<LH.Protocol.RawEventMessage>>}} TracingData */

  /**
   * @param {Array<LH.Config.Pass>} passes
   * @param {GatherRunnerOptions} options
   * @return {Promise<LH.Artifacts>}
   */
  static async run(passes, options) {
    const driver = options.driver;
    /** @type {TracingData} */
    const tracingData = {
      traces: {},
      devtoolsLogs: {},
    };
    /** @type {GathererResults} */
    const gathererResults = {
      LighthouseRunWarnings: [[]],
      fetchedAt: [(new Date()).toJSON()],
    };

    try {
      await driver.connect();
      await GatherRunner.loadBlank(driver);
      await GatherRunner.setupDriver(driver, gathererResults, options);

      // If the main document redirects, we'll update this to keep track
      let urlAfterRedirects = options.url;

      // Run each pass
      let firstPass = true;
      for (const passConfig of passes) {
        const passContext = Object.assign({}, options, {passConfig});

        await driver.setThrottling(options.settings, passConfig);
        await GatherRunner.beforePass(passContext, gathererResults);
        await GatherRunner.pass(passContext, gathererResults);
        const passLoadData = await GatherRunner.afterPass(passContext, gathererResults);

        // Save devtoolsLog, but networkRecords are discarded and not added onto artifacts.
        tracingData.devtoolsLogs[passConfig.passName] = passLoadData.devtoolsLog;

        // If requested by config, save pass's trace
        if (passLoadData.trace) {
          tracingData.traces[passConfig.passName] = passLoadData.trace;
        }

        if (firstPass) {
          urlAfterRedirects = passContext.url;
          firstPass = false;
        }
      }

      options.url = urlAfterRedirects;
      const artifacts = await GatherRunner.collectArtifacts(gathererResults);
      // Add tracing data and settings used to the artifacts object.
      return Object.assign(artifacts, tracingData, {settings: options.settings});

    } finally {
      // Clean up regardless of error.
      await GatherRunner.disconnectDriver(driver);
    }
  }
}

module.exports = GatherRunner;
