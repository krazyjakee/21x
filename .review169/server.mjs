import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
const server=await createServer({configFile:false,cacheDir:resolve('.review169-cache'),root:resolve('.review169'),resolve:{alias:{'@':resolve('src/renderer/src'),'@shared':resolve('src/shared')}},plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:5219,strictPort:true,fs:{allow:[process.cwd(),resolve('node_modules')]}}})
await server.listen()
console.log('Review fixture ready at http://127.0.0.1:5219')
