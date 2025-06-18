// Initialize Socket.IO with authentication
const socket = io("https://chat-app-backend-i6wo.onrender.com", {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  auth: {
    token: localStorage.getItem('chatToken')
  }
});

// DOM Elements (cached)
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
  header: document.querySelector('header') // Added for logout button
};

// State management
const state = {
  receivedMessages: new Set(),
  lastActivityTime: 0,
  currentRoom: null,
  activityTimer: null,
  currentUser: null
};

// Check authentication and load user
function checkAuth() {
  const token = localStorage.getItem('chatToken');
  if (!token) {
    window.location.href = '/auth/login.html';
    return;
  }

  // Verify token and get user info from backend
  fetch('https://chat-app-backend-i6wo.onrender.com/auth/me', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
  .then(response => {
    if (!response.ok) throw new Error('Not authenticated');
    return response.json();
  })
  .then(user => {
    state.currentUser = user;
    elements.nameInput.value = user.name; // Auto-fill name from auth
    elements.nameInput.disabled = true;   // Don't allow changing name
    setupLogoutButton();
  })
  .catch(() => {
    localStorage.removeItem('chatToken');
    window.location.href = '/auth/login.html';
  });
}

// Proper logout button setup
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

// Enhanced sanitization
function sanitize(input, maxLength = 500) {
  const div = document.createElement('div');
  div.textContent = input.length > maxLength ? input.substring(0, maxLength) : input;
  return div.innerHTML;
}

// Message display function
function displayMessage(data) {
  if (state.receivedMessages.has(data._id)) return;
  state.receivedMessages.add(data._id);

  const li = document.createElement('li');
  const isCurrentUser = data.name === state.currentUser?.name;
  const isAdmin = data.name === 'Admin';

  if (isAdmin) {
    li.className = 'post post--admin';
    li.innerHTML = `<div class="post__text">${data.text}</div>`;
  } else {
    li.className = isCurrentUser ? 'post post--left' : 'post post--right';
    li.innerHTML = `
      <div class="post__header ${isCurrentUser ? 'post__header--user' : 'post__header--reply'}">
        <span class="post__header--name">${data.name}</span> 
        <span class="post__header--time">${data.time}</span> 
      </div>
      <div class="post__text">${data.text}</div>`;
  }

  elements.chatDisplay.appendChild(li);
  elements.chatDisplay.scrollTop = elements.chatDisplay.scrollHeight;
}

// Message sending
function sendMessage(e) {
  e.preventDefault();
  if (!state.currentUser || !state.currentRoom) return;
  
  const text = elements.msgInput.value.trim();
  if (!text) return;

  socket.emit('message', {
    name: state.currentUser.name,
    text: sanitize(text),
    room: state.currentRoom
  });
  
  elements.msgInput.value = "";
  elements.msgInput.focus();
}

// Room management
function enterRoom(e) {
  e.preventDefault();
  if (!state.currentUser) return;
  
  const room = elements.chatRoom.value.trim();
  if (!room) return;

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

function leaveRoom() {
  if (!state.currentRoom || !state.currentUser) return;
  
  socket.emit('leaveRoom', { 
    name: state.currentUser.name,
    room: state.currentRoom
  });

  resetUI();
}

function resetUI() {
  state.currentRoom = null;
  elements.chatRoom.disabled = false;
  elements.chatDisplay.innerHTML = '';
  elements.usersList.textContent = '';
  elements.roomList.textContent = '';
  elements.activity.textContent = '';
  elements.leaveBtn.style.display = 'none';
  elements.msgInput.focus();
}

// Activity tracking
function handleActivity() {
  if (!state.currentUser) return;
  
  const now = Date.now();
  if (now - state.lastActivityTime > 1000) {
    socket.emit('activity', state.currentUser.name);
    state.lastActivityTime = now;
  }
}

// Initialize the app
function init() {
  checkAuth();
  
  // Event Listeners
  elements.formMsg.addEventListener('submit', sendMessage);
  elements.formJoin.addEventListener('submit', enterRoom);
  elements.leaveBtn.addEventListener('click', leaveRoom);
  elements.msgInput.addEventListener('input', handleActivity);

  // Socket Listeners
  socket.on("message", displayMessage);

  socket.on('messageHistory', (messages) => {
    const previousMessages = new Set(state.receivedMessages);
    state.receivedMessages.clear();
    elements.chatDisplay.innerHTML = '';

    messages.forEach(msg => {
      if (!previousMessages.has(msg._id)) {
        displayMessage(msg);
      }
    });
  });

  socket.on("activity", (name) => {
    clearTimeout(state.activityTimer);
    elements.activity.textContent = `${name} is typing...`;
    state.activityTimer = setTimeout(() => {
      elements.activity.textContent = "";
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

  socket.on('connect_error', (err) => {
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

// Start the application
init();
