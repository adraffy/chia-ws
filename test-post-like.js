import {Daemon} from './chia-ws.js';

const daemon = new Daemon({
	reconnect_cooldown: -1,	// dont reconnect
	idle_timeout: 0			// disconnect when idle
});

daemon.on('debug', console.log);

console.log(await daemon.query('get_blockchain_state'));

await new Promise(ful => {
	setTimeout(ful, 1000);
});

console.log(await daemon.get_service_states());

// should disconnect and exit 0