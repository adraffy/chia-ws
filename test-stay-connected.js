import {Daemon} from './chia-ws.js';

const daemon = new Daemon();

daemon.on('debug', console.log);

daemon.on('spam', (type, msg) => {	
	if (type == 'ack' && msg.command === 'new_farming_info') {
		console.log(msg.data);
	}
});
