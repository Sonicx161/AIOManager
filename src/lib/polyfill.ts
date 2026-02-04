import { v4 as uuidv4 } from 'uuid';

if (typeof crypto === 'undefined') {
    // @ts-ignore
    window.crypto = {};
}

if (!('randomUUID' in crypto) || typeof crypto.randomUUID !== 'function') {
    // @ts-ignore
    crypto.randomUUID = () => uuidv4();
}
