export function encodeAccountId(input) {
  const value = input.trim();
  if (/^\d{1,20}$/.test(value)) {
    let id = BigInt(value);
    if (id > 18446744073709551615n) throw new Error('The numeric account ID must fit in an unsigned 64-bit number.');
    const bytes = new Uint8Array(8);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number(id & 255n);
      id >>= 8n;
    }
    return btoa(String.fromCharCode(...bytes));
  }
  if (/^[A-Za-z0-9+/]{11}=$/.test(value) && btoa(atob(value)) === value) return value;
  throw new Error('Enter your numeric PSN account ID or its Base64 value. A PSN online name cannot be encoded as an account ID.');
}
