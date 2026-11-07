import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// One top-level component for both builds now — App.jsx itself branches
// on DEPLOY_MODE (see its own HOSTED constant/comment) rather than this
// file picking between two separate shells. No mode switch needed here
// anymore.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
