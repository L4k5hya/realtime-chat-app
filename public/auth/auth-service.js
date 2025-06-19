export function initializeAuth() {
    const API_URL = 'https://chat-app-backend-i6wo.onrender.com/auth';

    return {
        async login(email, password) {
            const response = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include', // ✅ Required for CORS
                body: JSON.stringify({ email, password })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Login failed');
            }

            return response.json();
        },

        async register(name, email, password) {
            const response = await fetch(`${API_URL}/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include', // ✅ Required for CORS
                body: JSON.stringify({ name, email, password })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Registration failed');
            }

            return response.json();
        },

        async getCurrentUser(token) {
            const response = await fetch(`${API_URL}/me`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                credentials: 'include' // ✅ Optional but safe to include
            });

            if (!response.ok) return null;
            return response.json();
        }
    };
}
