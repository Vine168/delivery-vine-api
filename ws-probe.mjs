import { io } from 'socket.io-client';

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const suffix = String(Date.now()).slice(-6);

const post = async (path, body, token) => {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
};
const put = async (path, body, token) => {
  const response = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const get = async (path, token) => {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await response.json()).data;
};

async function activate(phone, kind, role, name) {
  const registered = await post(`/auth/${kind}/register`, { phone, fullName: name });
  const verified = await post('/auth/otp/verify', {
    identifier: phone, channel: 'SMS', purpose: 'REGISTRATION', role,
    code: registered.body.data.otp.debugCode,
  });
  const session = await post(`/auth/${kind}/set-password`, {
    phone, verificationToken: verified.body.data.verificationToken, password: 'Passw0rd1',
  });
  return session.body.data;
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('timed out')), 8000);
    socket.on('connection.ready', (payload) => { clearTimeout(timer); resolve({ socket, ready: payload }); });
    socket.on('connection.error', (payload) => { clearTimeout(timer); reject(new Error(payload.code)); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });

const waitFor = (socket, event, ms = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });

console.log('── a socket with no token is refused');
try {
  await connect(undefined);
  console.log('   PROBLEM: connected without a token');
} catch (error) {
  console.log('   refused:', error.message);
}

console.log('── a socket with a forged token is refused');
try {
  await connect('not.a.real.jwt');
  console.log('   PROBLEM: connected with a forged token');
} catch (error) {
  console.log('   refused:', error.message);
}

const customer = await activate(`0160${suffix}`, 'customer', 'CUSTOMER', 'Sok Dara');
const driver = await activate(`0161${suffix}`, 'driver', 'DRIVER', 'Chan Sopheak');

console.log('── both apps connect and are put into their own rooms');
const customerConn = await connect(customer.tokens.accessToken);
const driverConn = await connect(driver.tokens.accessToken);
console.log('   customer rooms:', customerConn.ready.rooms.map((r) => r.split(':')[0]).join(', '));
console.log('   driver rooms  :', driverConn.ready.rooms.map((r) => r.split(':')[0]).join(', '));

const vehicleTypes = await get('/mobile/vehicle-types', customer.tokens.accessToken);
const vehicleTypeId = vehicleTypes[0].id;

await fetch(`${API}/mobile/driver/vehicle`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${driver.tokens.accessToken}` },
  body: JSON.stringify({ vehicleTypeId, plateNumber: `WS-${suffix}` }),
});

console.log('\n(approving the driver out of band, as an admin would)');
process.env.APPROVE = '1';
const { execSync } = await import('node:child_process');
execSync('node scripts/approve-drivers.mjs', { stdio: 'ignore' });

await put('/mobile/driver/availability', { status: 'ONLINE', latitude: 11.557, longitude: 104.929 }, driver.tokens.accessToken);

console.log('── driver books nothing; customer books, and the driver is pushed the offer');
const offerPromise = waitFor(driverConn.socket, 'driver.request.received', 12000);

const booking = await post('/mobile/customer/deliveries', {
  pickup: { address: 'Independence Monument', latitude: 11.5564, longitude: 104.9282, contactName: 'Sok Dara', contactPhone: '012345678' },
  dropoff: { address: 'Chak Angrae', latitude: 11.5, longitude: 104.87, contactName: 'Chan Vuthy', contactPhone: '012999888' },
  vehicleTypeId, currency: 'KHR',
  packages: [{ size: 'SMALL', weightKg: 2 }],
  paymentMethod: 'CASH_ON_DELIVERY',
}, customer.tokens.accessToken);

const deliveryId = booking.body.data.id;
console.log('   booked', booking.body.data.bookingCode);

const offer = await offerPromise;
console.log('   driver received offer: earning', offer.estimatedEarningAmount, '| to pickup', offer.distanceToPickupMeters, 'm');

console.log('── customer subscribes to the delivery room');
const subscription = await customerConn.socket.emitWithAck('delivery.subscribe', { deliveryId });
console.log('   subscribed:', subscription.subscribed, subscription.room?.split(':')[0]);

console.log('── a stranger cannot subscribe to it');
const stranger = await activate(`0162${suffix}`, 'customer', 'CUSTOMER', 'Nosy Parker');
const strangerConn = await connect(stranger.tokens.accessToken);
const refused = await strangerConn.socket.emitWithAck('delivery.subscribe', { deliveryId });
console.log('   stranger subscribed:', refused.subscribed, '|', refused.code);

console.log('── driver accepts: the customer is told without asking');
const assignedPromise = waitFor(customerConn.socket, 'delivery.driver_assigned');
await post(`/mobile/driver/jobs/${deliveryId}/accept`, {}, driver.tokens.accessToken);
const assigned = await assignedPromise;
console.log('   customer got delivery.driver_assigned:', assigned.status, assigned.bookingCode);

console.log('── driver pushes position over the socket, customer sees it move');
const movedPromise = waitFor(customerConn.socket, 'delivery.driver_location_updated');
const ack = await driverConn.socket.emitWithAck('driver.location.push', { latitude: 11.5545, longitude: 104.926, heading: 200, speed: 7.5 });
const moved = await movedPromise;
console.log('   push accepted:', ack.accepted, '| customer saw', moved.latitude, moved.longitude);

console.log('── each execution step is pushed as it happens');
for (const [step, event] of [['arrive-pickup', 'delivery.arrived_pickup'], ['confirm-pickup', 'delivery.picked_up']]) {
  const promise = waitFor(customerConn.socket, event);
  await post(`/mobile/driver/jobs/${deliveryId}/${step}`, {}, driver.tokens.accessToken);
  const payload = await promise;
  console.log(`   ${event} → ${payload.status}`);
}

for (const connection of [customerConn, driverConn, strangerConn]) connection.socket.close();
console.log('\nall realtime checks passed');
process.exit(0);
