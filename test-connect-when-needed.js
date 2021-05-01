import {Daemon} from './chia-ws.js';

const daemon = new Daemon({
	idle_timeout: 3000
});

daemon.on('debug', console.log);

console.log('Waiting...');
await new Promise(ful => {
	setTimeout(ful, 5000);
});
console.log(await daemon.get_service_states());