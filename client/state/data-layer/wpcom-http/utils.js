/** @format **/

/**
 * External dependencies
 */
import deterministicStringify from 'json-stable-stringify';
import { get, merge, noop, uniqueId } from 'lodash';

/**
 * Internal dependencies
 */
import config from 'config';

/**
 * Returns response data from an HTTP request success action if available
 *
 * @param {Object} action may contain HTTP response data
 * @returns {?*} response data if available
 */
export const getData = action => get( action, 'meta.dataLayer.data', null );

/**
 * Returns error data from an HTTP request failure action if available
 *
 * @param {Object} action may contain HTTP response error data
 * @returns {?*} error data if available
 */
export const getError = action => get( action, 'meta.dataLayer.error', null );

/**
 * Returns (response) headers data from an HTTP request action if available
 *
 * @param {Object} action may contain HTTP response headers data
 * @returns {?*} headers data if available
 */
export const getHeaders = action => get( action, 'meta.dataLayer.headers', null );

/**
 * @typedef {Object} ProgressData
 * @property {number} loaded number of bytes already transferred
 * @property {number} total total number of bytes to transfer
 */

/**
 * Returns progress data from an HTTP request progress action if available
 *
 * @param {Object} action may contain HTTP progress data
 * @returns {Object|null} progress data if available
 * @returns {ProgressData}
 */
export const getProgress = action => get( action, 'meta.dataLayer.progress', null );

const getRequestStatus = action => {
	if ( getError( action ) ) {
		return 'failure';
	}

	if ( getData( action ) ) {
		return 'success';
	}

	return 'pending';
};

export const getActionKey = fullAction => {
	const { meta, ...action } = fullAction; // eslint-disable-line no-unused-vars

	return deterministicStringify( action );
};

/**
 * Tracks the state of network activity for a given request type
 *
 * When we issue _REQUEST type actions they usually create some
 * associated network activity by means of an HTTP request.
 * We may want to know what the status of those requests are, if
 * they have completed or if they have failed.
 *
 * This tracker stores the meta data for those requests which
 * can then be independently polled by React components which
 * need to know about those data requests.
 *
 * Note that this is meta data about remote data requests and
 * _not_ about network activity, which is why this is code is
 * here operating on the _REQUEST actions and not in the HTTP
 * pipeline as a processor on HTTP_REQUEST actions.
 *
 * @param {Map} requests stores request meta data; must be Map-like with set/get
 * @param {Map} requestIds tracks requests by unique ids
 * @returns {Function} middleware function to track requests
 */
export const trackRequests = ( requests, requestIds ) => next => ( store, action ) => {
	// progress events don't affect
	// any tracking meta at the moment
	if ( getProgress( action ) ) {
		return next( store, action );
	}

	const actionKey = getActionKey( action );
	const status = getRequestStatus( action );
	const meta = requests.get( actionKey ) || {};
	const requestId = get( action, 'meta.dataLayer.requestId' ) || uniqueId( 'data-request-' );

	const nextMeta = Object.assign(
		{},
		meta,
		{
			requestId,
			status,
		},
		status !== 'pending' && { lastUpdated: Date.now() }
	);

	// update the meta
	requests.set( actionKey, nextMeta );

	// update the request mapping
	// the returning action could be
	// different than the first one
	// which originated the request
	if ( 'pending' === status ) {
		requestIds.set( requestId, actionKey );
	} else {
		const firstKey = requestIds.get( requestId );

		if ( firstKey && firstKey !== actionKey ) {
			requests.set( firstKey, nextMeta );
		}
	}

	next( store, merge( action, { meta: { dataLayer: { requestId } } } ) );
};

/** @type Map stores meta data about data request **/
const requestsMeta = new Map();
const requestsIds = new Map();

if ( 'development' === config( 'env_id' ) && typeof window === 'object' ) {
	window.dataRequests = requestsMeta;
	window.dataRequestIds = requestsIds;
}

/**
 * Builds a function to return request meta (used for testing)
 *
 * @see getRequestMeta
 *
 * @param {Map} requests stores request meta data; must be Map-like with set/get
 * @returns {Function} actually gets request meta given an action
 */
export const requestMetaGetter = requests => action => requests.get( getActionKey( action ) );

/**
 * Returns known information about a given data request
 *
 * @type {Function}
 * @param {Object} action data _REQUEST Redux action
 * @returns {Object} meta information about a data request
 */
export const getRequestMeta = requestMetaGetter( requestsMeta );

/**
 * @type Object default dispatchRequest options
 * @property {Function} middleware chain of functions to process before dispatch
 * @property {Function} onProgress called on progress events
 */
const defaultOptions = {
	middleware: trackRequests( requestsMeta, requestsIds ),
	onProgress: noop,
};

/**
 * Dispatches to appropriate function based on HTTP request meta
 *
 * @see state/data-layer/wpcom-http/actions#fetch creates HTTP requests
 *
 * When the WPCOM HTTP data layer handles requests it will add
 * response data and errors to a meta property on the given success
 * error, and progress handling actions.
 *
 * This function accepts three functions as the initiator, success,
 * and error handlers for actions and it will call the appropriate
 * one based on the stored meta. It accepts an optional fourth
 * function which will be called for progress events on upload.
 *
 * If both error and response data is available this will call the
 * error handler in preference over the success handler, but the
 * response data will also still be available through the action meta.
 *
 * The functions should conform to the following type signatures:
 *   initiator  :: ReduxStore -> Action -> Dispatcher (middleware signature)
 *   onSuccess  :: ReduxStore -> Action -> Dispatcher -> ResponseData
 *   onError    :: ReduxStore -> Action -> Dispatcher -> ErrorData
 *   onProgress :: ReduxStore -> Action -> Dispatcher -> ProgressData
 *
 * @param {Function} initiator called if action lacks response meta; should create HTTP request
 * @param {Function} onSuccess called if the action meta includes response data
 * @param {Function} onError called if the action meta includes error data
 * @param {Object} options configures additional dispatching behaviors
 * @param {Function} [options.middleware] runs before the dispatch itself
 * @param {Function} [options.onProgress] called on progress events when uploading
 * @returns {?*} please ignore return values, they are undefined
 */
export const dispatchRequest = ( initiator, onSuccess, onError, options ) => {
	const { middleware, onProgress } = Object.assign( defaultOptions, options );

	// this is an odd way of injecting middleware
	// normally we'd wrap the entire function from
	// the outside and use dependency injection
	// for providing the middleware
	// in this case we want to preserve the function
	// signature of `dispatchRequest` while allowing
	// for testing without middleware so we're just
	// going to go inside-out here
	return middleware( ( store, action ) => {
		const error = getError( action );
		if ( error ) {
			return onError( store, action, error );
		}

		const data = getData( action );
		if ( data ) {
			return onSuccess( store, action, data );
		}

		const progress = getProgress( action );
		if ( progress ) {
			return onProgress( store, action, progress );
		}

		return initiator( store, action );
	} );
};
