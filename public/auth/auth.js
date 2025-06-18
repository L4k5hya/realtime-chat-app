import { initializeAuth } from './auth-service.js';

// Initialize auth module
const auth = initializeAuth();

// Shared DOM elements
const showError = (elementId, message) => {
    const element = document.getElementById(elementId);
    if (!element.nextElementSibling?.classList.contains('error')) {
        const errorEl = document.createElement('div');
        errorEl.className = 'error';
        errorEl.style.color = 'red';
        errorEl.style.marginTop = '-0.5rem';
        errorEl.style.marginBottom = '1rem';
        element.after(errorEl);
    }
    element.nextElementSibling.textContent = message;
};

// Login Form
if (document.getElementById('loginForm')) {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        try {
            const user = await auth.login(email, password);
            localStorage.setItem('chatToken', user.token);
            window.location.href = '/'; // Redirect to chat
        } catch (error) {
            showError('loginPassword', error.message);
        }
    });
}

// Register Form
if (document.getElementById('registerForm')) {
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('registerName').value;
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirm').value;
        
        if (password !== confirmPassword) {
            showError('registerConfirm', 'Passwords do not match');
            return;
        }
        
        try {
            const user = await auth.register(name, email, password);
            localStorage.setItem('chatToken', user.token);
            window.location.href = '/'; // Redirect to chat
        } catch (error) {
            showError('registerPassword', error.message);
        }
    });
}