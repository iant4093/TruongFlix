const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;

export const IS_MAC = UA.includes('Mac');
export const IS_WINDOWS = UA.includes('Windows');
