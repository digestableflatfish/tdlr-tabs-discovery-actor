
import { Actor } from 'apify';

await Actor.init();

const input = await Actor.getInput();

console.log('TDLR collector started');
console.log('Input:', JSON.stringify(input));

await Actor.pushData({
    status: 'test_successful',
    message: 'Actor is running correctly',
    input
});

await Actor.exit();
