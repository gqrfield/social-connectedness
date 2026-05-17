import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/social-connectedness/', // Add this line (include the trailing and leading slashes!)
})