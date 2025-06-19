// Initialize Socket.IO with authentication
const socket = io("https://chat-app-backend-i6wo.onrender.com", {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  auth: {
    token: localStorage.getItem('chatToken')
  }
});

// DOM Elements
const elements = {
  msgInput: document.querySelector('#message'),
  nameInput: document.querySelector('#name'),
  chatRoom: document.querySelector('#room'),
  activity: document.querySelector('.activity'),
  usersList: document.querySelector('.user-list'),
  roomList: document.querySelector('.room-list'),
  chatDisplay: document.querySelector('.chat-display'),
  formJoin: document.querySelector('.form-join'),
  leaveBtn: document.querySelector('#leave-room'),
  formMsg: document.querySelector('.form-msg'),
  header: document.querySelector('header')
};

// App State
const state = {
  receivedMessages: new Set(),
  lastActivityTime: 0,
  currentRoom: null,
  activityTimer: null,
  currentUser: null
};

// Check token and get user info
function checkAuth() {
  const token = localStorage.getItem('chatToken');
  if (!token) {
    window.location.href = '/auth/login.html';
    return;
  }

  fetch('https://chat-app-backend-i6wo.onrender.com/auth/me', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
    .then(res => {
      if (!res.ok) throw new Error('Invalid token');
      return res.json();
    })
    .then(user => {
      state.currentUser = user;
      elements.nameInput.value = user.name;
      elements.nameInput.disabled = true;
      setupLogoutButton();
    })
    .catch(() => {
      localStorage.removeItem('chatToken');
      window.location.href = '/auth/login.html';
    });
}

// Add logout button
function setupLogoutButton() {
  const logoutBtn = document.createElement('button');
  logoutBtn.id = 'logout-btn';
  logoutBtn.textContent = 'Logout';
  logoutBtn.addEventListener('click', () => {
    if (state.currentRoom) {
      socket.emit('leaveRoom', {
        name: state.currentUser.name,
        room: state.currentRoom
      });
    }
    localStorage.removeItem('chatToken');
    window.location.href = '/auth/login.html';
  });
  elements.header.appendChild(logoutBtn);
}

// Sanitize text input
function sanitize(text, limit = 500) {
  const div = document.createElement('div');
  div.textContent = text.length > limit ? text.substring(0, limit) : text;
  return div.innerHTML;
}

// Display a message
function displayMessage(data) {
  if (state.receivedMessages.has(data._id)) return;
  state.receivedMessages.add(data._id);

  const li = document.createElement('li');
  const isSelf = data.name === state.currentUser?.name;
  const isAdmin = data.name === 'Admin';

  if (isAdmin) {
    li.className = 'post post--admin';
    li.innerHTML = `<div class="post__text">${data.text}</div>`;
  } else {
    li.className = isSelf ? 'post post--left' : 'post post--right';
    li.innerHTML = `
      <div class="post__header ${isSelf ? 'post__header--user' : 'post__header--reply'}">
        <span class="post__header--name">${sanitize(data.name)}</span>
        <span class="post__header--time">${sanitize(data.time)}</span>
      </div>
      <div class="post__text">${sanitize(data.text)}</div>
    `;
  }

  elements.chatDisplay.appendChild(li);
  elements.chatDisplay.scrollTop = elements.chatDisplay.scrollHeight;
}

// Send a message
function sendMessage(e) {
  e.preventDefault();
  const text = elements.msgInput.value.trim();
  if (!text || !state.currentUser || !state.currentRoom) return;

  socket.emit('message', {
    name: state.currentUser.name,
    text: sanitize(text),
    room: state.currentRoom
  });

  elements.msgInput.value = '';
  elements.msgInput.focus();
}

// Join a room
function enterRoom(e) {
  e.preventDefault();
  const room = elements.chatRoom.value.trim();
  if (!room || !state.currentUser) return;

  state.currentRoom = room;
  state.receivedMessages.clear();
  elements.chatDisplay.innerHTML = '';

  socket.emit('enterRoom', {
    name: state.currentUser.name,
    room: sanitize(room)
  });

  elements.chatRoom.disabled = true;
  elements.leaveBtn.style.display = 'inline-block';
  setTimeout(() => elements.msgInput.focus(), 100);
}

// Leave a room
function leaveRoom() {
  if (!state.currentRoom || !state.currentUser) return;

  socket.emit('leaveRoom', {
    name: state.currentUser.name,
    room: state.currentRoom
  });

  resetUI();
}

// Reset UI
function resetUI() {
  state.currentRoom = null;
  elements.chatRoom.disabled = false;
  elements.chatDisplay.innerHTML = '';
  elements.usersList.innerHTML = '';
  elements.roomList.innerHTML = '';
  elements.activity.textContent = '';
  elements.leaveBtn.style.display = 'none';
  elements.msgInput.focus();
}

// Emit typing activity
function handleActivity() {
  const now = Date.now();
  if (now - state.lastActivityTime > 1000 && state.currentUser) {
    socket.emit('activity', state.currentUser.name);
    state.lastActivityTime = now;
  }
}

// Main init
function init() {
  checkAuth();

  elements.formMsg.addEventListener('submit', sendMessage);
  elements.formJoin.addEventListener('submit', enterRoom);
  elements.leaveBtn.addEventListener('click', leaveRoom);
  elements.msgInput.addEventListener('input', handleActivity);

  socket.on('message', displayMessage);

  socket.on('messageHistory', messages => {
    elements.chatDisplay.innerHTML = '';
    messages.forEach(msg => displayMessage(msg));
  });

  socket.on('activity', name => {
    clearTimeout(state.activityTimer);
    elements.activity.textContent = `${name} is typing...`;
    state.activityTimer = setTimeout(() => {
      elements.activity.textContent = '';
    }, 3000);
  });

  socket.on('userList', ({ users }) => {
    elements.usersList.innerHTML = users?.length
      ? `<em>Users in ${sanitize(state.currentRoom)}:</em> ${users.map(u => sanitize(u)).join(', ')}`
      : '';
  });

  socket.on('roomList', ({ rooms }) => {
    elements.roomList.innerHTML = rooms?.length
      ? `<em>Active Rooms:</em> ${rooms.map(r => sanitize(r)).join(', ')}`
      : '';
  });

  socket.on('connect_error', err => {
    if (err.message === 'Authentication failed') {
      localStorage.removeItem('chatToken');
      window.location.href = '/auth/login.html';
    }
    elements.activity.textContent = "Connection lost...";
  });

  socket.on('reconnect', () => {
    elements.activity.textContent = "Reconnected!";
    if (state.currentRoom) {
      socket.emit('enterRoom', {
        name: state.currentUser.name,
        room: state.currentRoom
      });
    }
    setTimeout(() => elements.activity.textContent = "", 3000);
  });
}

// Start
init();
