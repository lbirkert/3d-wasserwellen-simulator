# 3D Wasserwellen Simulator

A interactive 3D water wave simulator built with **Google's Gemini AI** that visualizes wave superposition and interference patterns in real-time.

## About

This project simulates wave propagation and interference in three dimensions. Users can create multiple wave sources with customizable parameters (amplitude, frequency, phase) and observe how waves interact with each other. The simulator provides three visualization modes:

- **Wellen (Waves)**: Realistic water surface rendering with physics-based shading
- **Params 3D**: 3D visualization of wave parameters (elongation, velocity, acceleration, amplitude, phase)
- **Params 2D**: 2D top-down view of wave field data

Built with React, Three.js, and custom GLSL shaders for real-time wave calculations.

## Features

- 🌊 Real-time wave superposition calculations
- 🎨 Three visualization modes with dynamic color mapping
- ⚙️ Adjustable wave source parameters (position, amplitude, frequency, phase)
- 📊 Multiple data visualization modes (elongation, velocity, acceleration, amplitude envelope, phase difference)
- 🎮 Interactive 3D camera controls with orbit and zoom
- ⚡ Dynamic geometry LOD based on simulation speed
- 🎲 Randomization and reset controls

## Prerequisites

- **Node.js** (v16 or higher)
- **npm** or compatible package manager

## Setup Instructions

1. **Clone the repository**
   ```sh
   git clone https://github.com/yourusername/3d-wasserwellen-simulator.git
   cd 3d-wasserwellen-simulator
   ```

2. **Install dependencies**
   ```sh
   npm install
   ```

3. **Run the development server**
   ```sh
   npm run dev
   ```
   The application will start at `http://localhost:5173`

## Build Instructions

To create a production build:

```sh
npm run build
```

The optimized build output will be in the `dist` folder.

To preview the production build locally:

```sh
npm run preview
```

## Technology Stack

- **React** - UI framework
- **Three.js** - 3D graphics engine
- **@react-three/fiber** - React renderer for Three.js
- **@react-three/drei** - Useful Three.js utilities
- **TypeScript** - Type safety
- **Vite** - Modern build tool and dev server
- **GLSL** - Custom shaders for wave calculations

## Project Structure

```
├── index.tsx           # Main React application
├── index.html          # HTML template with styles
├── vite.config.ts      # Vite configuration
├── tsconfig.json       # TypeScript configuration
├── package.json        # Dependencies and scripts
└── .github/workflows/  # CI/CD pipeline (GitHub Pages deployment)
```

## Controls

### Camera
- **Rotate**: Click and drag
- **Zoom**: Scroll wheel
- **Pan**: Right-click and drag

### Wave Sources
- Adjust position, amplitude, frequency, and phase with sliders
- Toggle source visibility with the eye icon
- Delete sources with the trash icon
- Add new sources (up to 10 maximum)

### Simulation
- **Play/Pause**: Control wave animation
- **Reset Time**: Return to t=0
- **Randomize**: Generate random source parameters
- **Reset**: Restore default configuration

## Generated with Gemini

This project was created with **Google Gemini AI** and demonstrates the capabilities of AI-assisted full-stack web development including:
- Interactive 3D graphics implementation
- Physics-based wave simulation
- Complex GLSL shader programming
- Modern React and TypeScript development

## License

MIT
