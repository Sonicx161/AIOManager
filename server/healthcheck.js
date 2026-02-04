const http = require('http');

const options = {
    host: 'localhost',
    port: process.env.PORT || 1610,
    path: '/api/health',
    timeout: 2000
};

const request = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    if (res.statusCode === 200) {
        process.exit(0);
    } else {
        process.exit(1);
    }
});

request.on('error', (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
});

request.end();
