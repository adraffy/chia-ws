import {EventEmitter} from 'events';
import {Agent} from 'https';
import {readFileSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

// https://github.com/websockets/ws
import WebSocket from 'ws'; 

// chia services
const SERVICE_WALLET_UI = 'wallet_ui'; // magical
const SERVICE_DAEMON = 'daemon';
const SERVICE_NODE = 'chia_full_node';
const SERVICE_NODE_SIMULATOR = 'chia_full_node_simulator';
const SERVICE_INTRODUCER = 'chia_introducer';
const SERVICE_WALLET = 'chia_wallet';
const SERVICE_HARVESTER = 'chia_harvester';
const SERVICE_FARMER = 'chia_farmer';
const SERVICE_TIMELORD = 'chia_timelord';
const SERVICE_TIMELORD_LAUNCHER	= 'chia_timelord_launcher';

// commands used
const CMD_REGISTER_SERVICE = 'register_service';
const CMD_IS_RUNNING = 'is_running';

// command router
const CMD_DST = {};
Object.entries({
	[SERVICE_DAEMON]: [
		CMD_REGISTER_SERVICE,
		'start_service',
		'stop_service',
		CMD_IS_RUNNING,
		'get_status'
	],
	[SERVICE_NODE]: [
		'get_blockchain_state', 
		'get_block',
		'get_blocks',
		'get_block_record_by_height',
		'get_block_record',
		'get_block_records',
		'get_unfinished_block_headers',
		'get_network_space',
		'get_additions_and_removals',
		'get_initial_freeze_period',
		'get_network_info',
		'get_coin_records_by_puzzle_hash',
		'get_coin_record_by_name',
		'push_tx',
		'get_all_mempool_tx_ids',
		'get_all_mempool_items',
		'get_mempool_item_by_tx_id'
	],
	[SERVICE_WALLET]: [
		'log_in',
		'get_public_keys',
		'get_private_key',
		'generate_mnemonic',
		'add_key',
		'delete_key',
		'delete_all_keys',
		'get_sync_status',
		'get_height_info',
		'get_initial_freeze_period',
		'get_network_info',
		'get_wallets',
		'get_wallet_balance',
		'get_transaction',
		'get_transactions',
		'get_next_address',
		'send_transaction',
		'create_backup',
		'get_transaction_count',
		'get_farmed_amount'
	],
	[SERVICE_HARVESTER]: [
		'get_plots',
		'refresh_plots',
		'delete_plot',
		'add_plot_directory',
		'get_plot_directories',
		'remove_plot_directory'
	],
	[SERVICE_FARMER]: [
		'get_signage_point',
		'get_signage_points',
		'get_reward_targets',
		'set_reward_targets'
	]
}).forEach(([service, v]) => {
	for (const cmd of v) {
		CMD_DST[cmd] = service;
	}
});

// increase an uint8array/buffer by one
function advance(v) {
	const n = v.length;
	for (let i = n - 1; i >= 0; i--) {
		const x = v[i];
		if (x < 0xFF) {
			v[i] = x + 1;
			break;
		}
		v[i] = 0;
	}
	return v;
}

function create_agent(opts) {
	if (opts.agent instanceof Agent) {
		return opts.agent;
	}
	const daemon_prefix = 'config/ssl/daemon/private_daemon'; 
	let prefix;
	if (typeof opts.ssl_prefix === 'string') {
		prefix = opts.ssl_prefix;
	} else if (typeof opts.root === 'string') {
		prefix = join(opts.root, daemon_prefix);
	} else {
		let {home} = opts;
		if (typeof home !== 'string') home = homedir();
		prefix = join(home, '.chia/mainnet', daemon_prefix);
	}
	return new Agent({
		rejectUnauthorized: false,
		cert: readFileSync(prefix + '.crt'),
		key: readFileSync(prefix + '.key')
	});
}

function wrap_error(err, reason) {
	if (err instanceof Error) {
		return err;
	} else if (typeof err === 'string') {
		return new Error(err);
	} else {
		return new Error(reason);
	}
}

// events:
// 'debug' (desc:str)
// 'open' ()
// 'close' (Error)
// 'connect-error' (Error)
// 'spam' (type:str, msg:Object)

// typical init:
// {reconnect_cooldown: 5000, idle_timeout: -  1} :: stay connected forever
// {reconnect_cooldown:   -1, idle_timeout:    0} :: disconnect immediately when idle
// {reconnect_cooldown: 1000, idle_timeout: 5000} :: try forever to connect

export class Daemon extends EventEmitter {
	
	constructor(opts) {
		super();
		if (opts !== undefined && typeof opts !== 'object') {
			throw new Error('expected options object');
		}
		opts = {
			host: 'localhost',
			port: 55400,
			connect_timeout: 30000,
			request_timeout: 10000,
			reconnect_cooldown: 5000,
			idle_timeout: -1,
			heartbeat_period: 30000,
			...opts
		};
		
		this.agent = create_agent(opts);
		this.url = `wss://${opts.host}:${opts.port}`;
		
		this.terminated = false;
		this.connected = false;
		this.disconnecting = false;
		this.sending = false;

		this.heartbeat_timer = false;
		this.reconnect_timer = false;
		this.connect_timer = false;
		this.idle_timer = false;
		
		this.ws = false;
		this.req_queue = [];
		this.req_map = {};
		this.req_id = Buffer.alloc(32);

		this.connect_timeout = opts.connect_timeout|0; // <=0 = no timeout
		this.request_timeout = opts.request_timeout|0; // <=0 = no timeout
		this.heartbeat_period = opts.heartbeat_period|0; // <0 = disabled
		this.reconnect_cooldown = opts.reconnect_cooldown|0; // <0 = disabled
		this.idle_timeout = opts.idle_timeout|0; // <0 = infinite, 0 = immediate
		
		if (this.idle_timeout < 0 && this.reconnect_cooldown >= 0) {
			setTimeout(() => this.connect(), 0);
		}
	}

	// private
	send_next() {
		if (this.req_queue.length == 0) return; // nothing to send
		if (!this.connected) { // not connected
			this.connect(); 
			return;
		}
		if (this.sending) return; // already sent shit
		this.sending = true;
		clearTimeout(this.idle_timer);
		const query = this.req_queue.shift(); // burn next request
		query.sent = true;
		this.ws.send(JSON.stringify(query.req), () => {
			this.sending = false;
			this.send_next(); // this prevents burning the entire queue
		});
	}
	
	disconnect(err, idle) {
		if (!this.ws) return; // no connection active
		if (this.disconnecting) return; // already disconnecting
		this.disconnecting = true;
		const was = this.connected;
		this.connected = false;
		clearTimeout(this.idle_timer);
		clearTimeout(this.connect_timer);
		clearTimeout(this.heartbeat_timer);
		this.ws.terminate(); // kill connection
		this.ws = false; 
		err = wrap_error(err, 'user disconnect');
		for (const query of Object.values(this.req_map)) {
			if (this.terminated || this.reconnect_cooldown < 0 || query.sent) {
				this.reject_query(query, err);
			}
		}
		this.disconnecting = false;
		if (!idle && this.reconnect_cooldown >= 0) {
			let cooldown = this.reconnect_cooldown;
			if (was) { // reduce cooldown by connected duration
				cooldown -= Math.min(cooldown, Date.now() - this.connect_time);
			}
			this.emit('debug', `Reconnect in ${cooldown}ms`);
			this.reconnect_timer = setTimeout(() => {
				this.reconnect_timer = false;
				if (this.idle_timeout >= 0 && this.is_idle) {
					this.emit('debug', `Reconnect avoided while idle`);
					return;
				}
				this.connect();
			}, cooldown);
		}
		if (was) {
			this.emit('debug', `Disconnected: ${err.message}`);
			this.emit('close', err);
		} else {
			this.emit('debug', `Connect Error: ${err.message}`);
			this.emit('connect-error', err);
		}
	}
	
	connect() {
		if (this.terminated) return; // terminated
		if (this.disconnecting) return; // during disconnect
		if (this.reconnect_timer) return; // reconnect cooldown
		if (this.ws) return; // already connecting
		this.ws = new WebSocket(this.url, {
			agent: this.agent,
			perMessageDeflate: false,
			maxPayload: 1024*1024*10 // from chia gui 
		});
		if (this.connect_timeout > 0) {
			this.connect_timer = setTimeout(() => {
				this.disconnect(new Error(`connect timeout`));
			}, this.connect_timeout);
		} 
		this.emit('debug', `Connecting...`);
		this.ws.once('open', () => {
			this.emit('debug', `Handshaking...`);
			// immediately send register_service
			// so the daemon routes requests for us
			this.ws.send(JSON.stringify(this.create_query(this.prepare({
				command: CMD_REGISTER_SERVICE, 
				data: {service: SERVICE_WALLET_UI}
			}), 0, () => {
				clearTimeout(this.connect_timer);
				this.connected = true;
				this.connect_time = Date.now();
				this.sending = false;
				if (this.idle_timeout < 0) { // only send heartbeat if we're connected forever
					this.schedule_heartbeat();
				}
				this.schedule_idle();
				this.emit('debug', `Connected`);
				this.emit('open');
				this.send_next();
			}, (reason) => {
				const err = new Error(`handshake failed`);
				err.reason = reason;
				this.disconnect(err);
			}).req));
		});
		this.ws.on('pong', () => {
			this.schedule_heartbeat();
			this.emit('heartbeat');
		});
		this.ws.on('message', (data) => {
			let msg;
			try {
				msg = JSON.parse(data);
			} catch (reason) {
				const err = new Error(`expected json`);
				err.reason = reason;
				err.data = data;
				this.disconnect(err);
				return;
			}
			if (!msg.ack) {
				if (this.connected) {
					this.emit('spam', 'ack', msg); 
				}
				return;
			}
			const query = this.req_map[msg.request_id];
			if (!query) {
				if (this.connected) {
					this.emit('spam', 'req', msg);
				}
				return; 
			}
			delete this.req_map[msg.request_id];
			this.schedule_idle();
			const {req, ful, rej, timeout, t0} = query;
			clearTimeout(timeout);
			if (msg.data?.success) {
				ful({req, res: msg.data, t: Date.now() - t0});
			} else {
				const err = new Error(`${req.command} failed`);  // use err.req 
				err.req = req;
				err.res = msg;
				rej(err);
			}
		});
		this.ws.once('close', (code, reason) => {
			const err = new Error(`unexpected close`);
			err.reason = reason;
			err.code = code;
			this.disconnect(err);
		});
		this.ws.once('error', reason => {
			const err = new Error(`connection error`);
			err.reason = reason;
			this.disconnect(err);
		});
	}
	
	// private
	create_query(req, timeout, ful, rej) {
		const timer = timeout > 0 ? setTimeout(() => {
			this.cancel(req, new Error(`timeout`));
		}, timeout) : false;
		const query = {req, ful, rej, timeout: timer, t0: Date.now()};
		this.req_map[req.request_id] = query;
		return query;
	}
	
	// private
	reject_query(query, err) {
		clearTimeout(query.timeout);
		const i = this.req_queue.indexOf(query);
		if (i >= 0) {
			this.req_queue.splice(i, 1);
		}
		delete this.req_map[query.req.request_id];
		err.req = query.req;
		query.rej(err);
	}
	
	// ************************************************************
	
	// pseudo-private
	// reschedule the heartbeat
	// can be called manually after changing the timer
	schedule_heartbeat() {
		clearTimeout(this.heartbeat_timer);
		if (this.heartbeat_period > 0) {
			this.heartbeat_timer = setTimeout(() => this.ws.ping(), this.heartbeat_period);
		}
	}
	
	// pseudo-private
	// returns true if
	// no requests are inflight
	// no requests are waiting to be sent
	get is_idle() {
		return this.req_queue.length == 0 && Object.keys(this.req_map).length == 0;
	}
	
	// private
	// schedule idle timer
	// if there no requests queued or waiting results
	schedule_idle() {
		clearTimeout(this.idle_timer); // question: can this ever be alive?
		if (this.idle_timeout >= 0 && this.is_idle) {
			const phase1 = this.idle_timeout / 2; // initial delay
			const phase2 = this.idle_timeout - phase1;
			this.idle_timer = setTimeout(() => {
				// delay showing output until some time goes by
				if (phase1 > 0) { // but skip if instantenous 
					this.emit('debug', `Idle for more than ${phase1}ms...`);
				}
				this.idle_timer = setTimeout(() => {
					this.disconnect(new Error(`idle timeout`), true); // prevent automatic reconnect
				}, phase2);
			}, phase1);
		}
	}
	
	// terminate the daemon
	// never connect again
	// cancel all existing requests
	shutdown() {
		if (this.terminated) return; // already terminated
		this.terminated = true;
		clearTimeout(this.reconnect_timer);
		this.disconnect(new Error(`terminated`), true);
	}
	
	// format a chia msg
	// throws if fucky
	prepare(msg) {
		if (typeof msg === 'string') {
			msg = {command: msg};
		}
		if (typeof msg.command !== 'string') {
			throw new Error(`missing command: ${msg}`);
		}
		if (typeof msg.destination !== 'string') {
			let dst = CMD_DST[msg.command];
			if (!dst) {
				throw new Error(`unknown command destination: ${msg.command}`);
			}
			msg.destination = dst;
		}
		if (typeof msg.request_id !== 'string') {
			msg.request_id = advance(this.req_id).toString('hex');
		}
		msg.origin = SERVICE_WALLET_UI;
		msg.ack = false;
		return msg;
	}
	
	// cancel an issued request
	// this only works if you prepare() first
	// since you need the corresponding req or request_id 
	// note: err is optional
	// returns boolean if sent already
	// returns undefined if unknown
	cancel(req, err) {
		if (typeof req === 'object') {
			req = req.request_id; // unwrap request
		}
		err = wrap_error(err, 'user cancelled');
		const query = this.req_map[req];
		if (!query) return;
		this.reject_query(query, err);
		this.schedule_idle();
		return query.sent;
	}
	
	// issue a request 
	// throws immediately if prepare() fails
	// returns a promise 
	// if .success, resolves to {req, res}
	// else, throws with Error having .req/.res properties
	query(req) {
		if (this.terminated) throw new Error(`terminated`);
		req = this.prepare(req);
		clearTimeout(this.idle_timer);
		return new Promise((ful, rej) => {
			this.req_queue.push(this.create_query(req, this.request_timeout, ful, rej));
			this.send_next();
		});
	}
	
	// convenience function
	// returns daemon service states
	get_service_states() {
		return Promise.all([
			SERVICE_NODE,
			SERVICE_WALLET,
			SERVICE_HARVESTER,
			SERVICE_FARMER,
			SERVICE_NODE_SIMULATOR,
			SERVICE_INTRODUCER,
			SERVICE_TIMELORD,
			SERVICE_TIMELORD_LAUNCHER
		].map(service => this.query({command: CMD_IS_RUNNING, data: {service}}).then(({req, res}) => {
			return [res.service_name, res.is_running];
		}))).then(Object.fromEntries);
	}
	
	/*
	// example
	get_blockchain_state() {
		return this.query('get_blockchain_state').then(x => x.res.blockchain_state);
	}
	*/
	
}