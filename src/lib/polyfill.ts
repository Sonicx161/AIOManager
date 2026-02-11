import { v4 as uuidv4 } from 'uuid';

if (typeof crypto === 'undefined') {
    // @ts-expect-error - polyfill for non-standard window property
    window.crypto = {};
}

if (!('randomUUID' in crypto) || typeof crypto.randomUUID !== 'function') {
    // @ts-expect-error - polyfill for non-standard crypto method
    crypto.randomUUID = () => uuidv4();
}
