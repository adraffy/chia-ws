import {Daemon} from './chia-ws.js';

// initialize with current user (~/.chia/mainnet)
const daemon = new Daemon(); 
// or, initialize with certs at a specific location
// eg. new Daemon({ssl_prefix: "/path/to/ssl/daemon/private_daemon" (no ext)})
// or, initialize with chia root
// new Daemon{{root: "/users/farmer/.chia/"}

// the daemon is connected
daemon.on('open', () => {});

// the daemon was disconnnected
daemon.on('close', (err) => {});

// error occurred during connection
daemon.on('connect-error', (err) => {
	console.log(err);
});

daemon.on('spam', (type, msg) => {
	// type = 'ack' => non-request responses, eg. periodic updates to ui
	// type = 'req' => responses that we have no knowledge of a request
});

// poor mans keep-alive
// can be disabled by using a non-positive heartbeat_period
daemon.on('heartbeat', () => {
	console.log('beat');	
});

// this is a custom call that issues "is_running" on known services
// returns {service: state, ...}
console.log(await daemon.get_service_states())

// standard rpc calls with automatic routing
// daemon.query takes a command name or a command object and returns a promise
// doesn't matter if the underlying socket isn't connected yet
// returns {req, res} such that:
// req = original command
// res = 'data' from the corresponding server response
// throws if disconnected
// throws if success = false, check err.req/.res

{
	const {req, res} = await daemon.query('get_blockchain_state');
	console.log(res);
}

{
	const {req, res} = await daemon.query({command: 'get_wallet_balance', data: {wallet_id: 1}});
	console.log(res);
}

{
	const {req, res} = await daemon.query('get_farmed_amount');
	console.log(res);
}

// make a failed response
try {
	const {req, res} = await daemon.query('get_wallet_balance'); // missing data.wallet_id
} catch (err) {
	console.error(err);
}

// by default, the daemon is setup to reconnect after 5 sec and stay connected (no idle timeout)
// so we need to terminate it otherwise this demo will stay active
// you can customize this using the reconnet_cooldown and idle_timeout parameters (see: chia-ws.js)
daemon.shutdown();