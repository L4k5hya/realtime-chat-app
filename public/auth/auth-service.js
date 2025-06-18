export function initializeAuth() {
    const API_URL = 'http://localhost:3500/auth'; // Match your backend port
    
    return {
        async login(email, password) {
            const response = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Login failed');
            }
            
            return response.json();
        },
        
        async register(name, email, password) {
            const response = await fetch(`${API_URL}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Registration failed');
            }
            
            return response.json();
        },
        
        async getCurrentUser(token) {
            const response = await fetch(`${API_URL}/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) return null;
            return response.json();
        }
    };
}