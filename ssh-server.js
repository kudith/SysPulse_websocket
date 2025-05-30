const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ssh2 = require("ssh2");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN ||
      (process.env.NODE_ENV === "production"
        ? process.env.PRODUCTION_URL || "https://syspulse.yourdomain.com"
        : "http://localhost:3000"),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// State management - functional approach using global objects/maps instead of classes
const sshConnections = new Map();
const socketToSession = new Map();

// Command Queue Implementation - functional approach with closure for state
const createCommandQueue = (maxConcurrent = 3, delayBetweenCommands = 300) => {
  let queue = [];
  let running = 0;

  const processQueue = () => {
    if (queue.length === 0 || running >= maxConcurrent) {
      return;
    }

    running++;
    const { connection, command, callback, socket, sessionId, socketId, background = false } = queue.shift();

    // Track if command background
    if (connection && connection.sshStream) {
      console.log(`${socketId}: Setting background flag to ${background} for command`);
      connection.runningBackgroundCommand = background;
    }

    // Only log foreground commands or if debugging
    if (!background) {
      console.log(
        `Command Queue: Processing command: ${command} (running: ${running}, queued: ${queue.length})`
      );
    } else {
      console.log(
        `Command Queue: Processing background command (running: ${running}, queued: ${queue.length})`
      );
    }

    try {
      const sshClient = connection.sshClient;

      sshClient.exec(command, (err, stream) => {
        if (err) {
          // Handle error
          console.error(`${socketId}: Error executing command: ${err.message}`);
          running--;
          processQueue();
          if (typeof callback === "function") {
            callback({ error: err.message, output: "", background });
          }
          return;
        }

        connection.lastActivity = new Date();

        let output = "";
        let errorOutput = "";

        // Collect data from stdout
        stream.on("data", (data) => {
          output += data.toString("utf8");

          // If not background command and stream option is true, send directly
          if (!background && socket && connection.options && connection.options.stream) {
            socket.emit("command-output-stream", {
              executionId: connection.executionId,
              output: data.toString("utf8"),
              partial: true
            });
          }
        });

        // Collect data from stderr
        stream.stderr.on("data", (data) => {
          errorOutput += data.toString("utf-8");
        });

        // Handle end of stream
        stream.on("close", (code) => {
          // Reset background command tracking
          if (connection) {
            connection.runningBackgroundCommand = false;
          }

          // Only log non-background commands
          if (!background) {
            console.log(`${socketId}: Command executed with code ${code}`);

            if (code !== 0) {
              console.log(`${socketId}: Command stderr: ${errorOutput}`);
            }
          }

          if (typeof callback === "function") {
            // Return both output and errorOutput
            callback({
              error: code !== 0 ? `Command exited with code ${code}` : null,
              output: output,
              errorOutput: errorOutput,
              background // Include background flag in response
            });
          }

          // Release this slot after a brief delay to avoid overwhelming the SSH server
          setTimeout(() => {
            running--;
            processQueue();
          }, delayBetweenCommands);
        });

        // Handle any errors on the stream
        stream.on("error", (err) => {
          console.error(
            `${socketId}: Stream error during command: ${err.message}`
          );
          if (typeof callback === "function") {
            callback({
              error: `Stream error: ${err.message}`,
              output: output,
              errorOutput,
              background
            });
          }

          // Release this slot after a brief delay
          setTimeout(() => {
            running--;
            processQueue();
          }, delayBetweenCommands);
        });
      });
    } catch (error) {
      console.error(
        `${socketId}: Exception executing command: ${error.message}`
      );
      if (typeof callback === "function") {
        callback({ error: error.message, output: "", background });
      }

      // Release this slot after a brief delay
      setTimeout(() => {
        running--;
        processQueue();
      }, delayBetweenCommands);
    }
  };

  return {
    add: (commandObj) => {
      queue.push(commandObj);
      processQueue();
    },
    
    processQueue,
    
    clearSessionCommands: (sessionId) => {
      queue = queue.filter((item) => item.sessionId !== sessionId);
    },
    
    getQueueState: () => ({
      queue: queue.length,
      running
    })
  };
};

// Create global command queue
const cmdQueue = createCommandQueue();

// SSH connection management functions
const cleanupConnection = (socketId, sessionId) => {
  // Only clean up if we have a valid session ID
  if (!sessionId) {
    socketToSession.delete(socketId);
    return;
  }

  // Get connection information
  const connection = sshConnections.get(sessionId);
  if (!connection) {
    socketToSession.delete(socketId);
    return;
  }

  // Clear any pending timeouts
  if (connection.hardAuthTimeout) {
    clearTimeout(connection.hardAuthTimeout);
    connection.hardAuthTimeout = null;
  }

  // Clear any monitoring timers
  if (connection.monitoringTimer) {
    clearInterval(connection.monitoringTimer);
    connection.monitoringTimer = null;
  }

  // Clear high frequency monitoring timer if exists
  if (connection.highFreqMonitoringTimer) {
    clearInterval(connection.highFreqMonitoringTimer);
    connection.highFreqMonitoringTimer = null;
  }

  // Clear any pending commands for this session
  cmdQueue.clearSessionCommands(sessionId);

  // Close SSH stream if it exists
  if (connection.sshStream && !connection.sshStream.destroyed) {
    console.log(
      `${socketId}: Destroying SSH stream for session ${sessionId}`
    );
    try {
      connection.sshStream.destroy();
    } catch (err) {
      console.error(`${socketId}: Error destroying stream: ${err.message}`);
    }
  }

  // Close SSH client if it exists
  if (connection.sshClient) {
    console.log(`${socketId}: Ending SSH client for session ${sessionId}`);
    try {
      if (connection.sshClient._sock) {
        // Force destroy the socket to ensure it's closed
        connection.sshClient._sock.destroy();
      }
      connection.sshClient.end();
    } catch (err) {
      console.error(`${socketId}: Error ending client: ${err.message}`);
    }
  }

  // Remove mappings
  socketToSession.delete(socketId);
  sshConnections.delete(sessionId);

  console.log(`${socketId}: Connection cleaned up for session ${sessionId}`);
};

// Terminal shell management
const createShell = (clientSocket, connection) => {
  if (!connection || !connection.sshClient) {
    console.error(
      `${clientSocket.id}: Cannot create shell - SSH client not available`
    );
    clientSocket.emit("ssh-error", { message: "SSH client not available" });
    return;
  }

  console.log(`${clientSocket.id}: Creating new shell session`);

  const cols = connection.cols || 80;
  const rows = connection.rows || 24;

  // Create shell with proper terminal dimensions
  const shellConfig = {
    term: "xterm-256color",
    cols: cols,
    rows: rows,
  };

  // Use a Promise with timeout to handle shell creation
  new Promise((resolve, reject) => {
    try {
      // Set a timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error("Shell creation timeout"));
      }, 5000);

      connection.sshClient.shell(shellConfig, (err, stream) => {
        clearTimeout(timeout);

        if (err) {
          reject(err);
          return;
        }

        resolve(stream);
      });
    } catch (err) {
      reject(err);
    }
  })
    .then((stream) => {
      console.log(
        `${clientSocket.id}: New shell stream created successfully`
      );
      connection.sshStream = stream;

      // Update last activity
      connection.lastActivity = new Date();

      // Set up stream handlers with better buffering
      let dataBuffer = "";
      let dataTimeout;
      const BUFFER_FLUSH_INTERVAL = 50;

      // Add tracking for background command running
      connection.runningBackgroundCommand = false;

      // Efficient data handling with smarter batching
      stream.on("data", (data) => {
        // Data from background command should not be sent to terminal
        if (connection.runningBackgroundCommand === true) {
          console.log(`${clientSocket.id}: Skipping terminal output for background command`);
          return;
        }

        // Output handler for foreground commands (normal output)
        const strData = data.toString("utf-8");
        connection.lastActivity = new Date();

        // Add to buffer
        dataBuffer += strData;

        clearTimeout(dataTimeout);
        dataTimeout = setTimeout(() => {
          if (dataBuffer.length > 0) {
            // Send buffer to client
            clientSocket.emit("ssh-data", dataBuffer);
            dataBuffer = "";
          }
        }, BUFFER_FLUSH_INTERVAL);
      });

      // Handle stderr data
      stream.stderr.on("data", (data) => {
        connection.lastActivity = new Date();
        if (data && data.length > 0) {
          const stringData = data.toString("utf-8");
          clientSocket.emit("ssh-error-data", stringData);
        }
      });

      // Ensure dataBuffer is sent when stream closes
      stream.on("close", (code, signal) => {
        // Send any remaining data in buffer
        if (dataBuffer.length > 0) {
          try {
            clientSocket.emit("ssh-data", dataBuffer);
          } catch (err) {
            console.error(
              `${clientSocket.id}: Error sending final data to client: ${err.message}`
            );
          }
        }

        console.log(
          `${clientSocket.id}: SSH stream closed. Code: ${code}, Signal: ${signal}`
        );
        clientSocket.emit("ssh-closed", {
          message: `SSH connection closed (${code ? "code: " + code : ""} ${
            signal ? "signal: " + signal : ""
          })`.trim(),
        });
      });

      // Execute initial commands to check system resources
      // Note: this runs AFTER successful connection to avoid race conditions
      clientSocket.emit(
        "ssh-data",
        "\r\n\x1b[32m# Connection successful\x1b[0m\r\n"
      );

      // Run initialization commands in background
      console.log(`${clientSocket.id}: Running initialization and system check in background`);

      // Create batch of initialization commands with background flag
      cmdQueue.add({
        connection,
        command: "uname -a",
        socket: clientSocket,
        socketId: clientSocket.id,
        sessionId: connection.sessionId,
        background: true,
        callback: (result) => {
          // Process result in background, can be sent through special event
          if (!result.error) {
            // Save system info in connection state if needed
            connection.systemInfo = result.output;
            
            // Send to client through special event, not to terminal
            clientSocket.emit("system-info", { type: "uname", data: result.output });
          }
        }
      });

      // Run uptime in background too
      cmdQueue.add({
        connection,
        command: "uptime",
        socket: clientSocket,
        socketId: clientSocket.id,
        sessionId: connection.sessionId,
        background: true,
        callback: (result) => {
          if (!result.error) {
            clientSocket.emit("system-info", { type: "uptime", data: result.output });
          }
        }
      });

      // Start system monitoring after 2 seconds
      setTimeout(() => setupThrottledMonitoring(clientSocket, connection), 2000);
    })
    .catch((err) => {
      console.error(
        `${clientSocket.id}: Failed to create shell: ${err.message}`
      );
      clientSocket.emit("ssh-error", {
        message: `Failed to create shell: ${err.message}`,
      });
    });
};

// Fix the setupThrottledMonitoring function

const setupThrottledMonitoring = (clientSocket, connection) => {
  // Prevent multiple monitoring timers
  if (connection.monitoringActive) return;

  connection.monitoringActive = true;
  
  // Clear existing timer if any
  if (connection.monitoringTimer) {
    clearInterval(connection.monitoringTimer);
  }
  
  // Set up monitoring interval
  connection.monitoringTimer = setInterval(async () => {
    try {
      // Check if connection and SSH client are still valid
      if (!connection || !connection.sshClient || connection.sshClient.destroyed) {
        console.log("SSH connection no longer valid, stopping monitoring");
        if (connection.monitoringTimer) {
          clearInterval(connection.monitoringTimer);
          connection.monitoringTimer = null;
        }
        connection.monitoringActive = false;
        return;
      }
      
      // Execute both commands using exec method safely
      const cpuCommand = "top -bn1 | grep '%Cpu' | awk '{print $2}'";
      const memCommand = "free | grep Mem | awk '{print ($3/$2) * 100.0}'";
      
      // Use the command queue instead of direct exec for better stability
      connection.sshClient.exec(cpuCommand, (err, stream) => {
        if (err) return;
        let cpuData = '';
        stream.on('data', (chunk) => { cpuData += chunk; });
        
        stream.on('end', () => {
          const cpuValue = parseFloat(cpuData.trim());
          
          // Get memory data only after CPU data is ready
          connection.sshClient.exec(memCommand, (err, stream) => {
            if (err) return;
            let memData = '';
            stream.on('data', (chunk) => { memData += chunk; });
            
            stream.on('end', () => {
              const memValue = parseFloat(memData.trim());
              
              // Only send if we have valid data
              if (!isNaN(cpuValue) && !isNaN(memValue)) {
                clientSocket.emit('monitoring-data', {
                  type: 'system-stats',
                  stats: {
                    cpu: { value: cpuValue },
                    memory: { value: memValue }
                  }
                });
              }
            });
          });
        });
      });
    } catch (err) {
      console.error('Error collecting system stats:', err);
    }
  }, 1000); // Run every second
};

// Start heartbeat for client connection
const startHeartbeat = (socket, sessionId) => {
  // Clear any existing heartbeat interval
  if (socket.heartbeatInterval) {
    clearInterval(socket.heartbeatInterval);
    socket.heartbeatInterval = null;
  }

  // Set up heartbeat
  socket.heartbeatInterval = setInterval(() => {
    if (!sshConnections.has(sessionId)) {
      clearInterval(socket.heartbeatInterval);
      socket.heartbeatInterval = null;
      return;
    }

    // Send a lightweight heartbeat to keep the connection alive
    socket.emit("ssh-heartbeat", { timestamp: Date.now() });
  }, 5000); // Every 5 seconds

  // Clean up on disconnect
  socket.once("disconnect", () => {
    if (socket.heartbeatInterval) {
      clearInterval(socket.heartbeatInterval);
      socket.heartbeatInterval = null;
    }
  });
};

// Socket.IO event handlers
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Check if the client has a session ID in auth data
  const sessionId = socket.handshake.auth?.sessionId;
  if (sessionId) {
    console.log(
      `Client ${socket.id} attempting to reconnect with session ID: ${sessionId}`
    );

    // Check if the session exists
    if (sshConnections.has(sessionId)) {
      const existingConnection = sshConnections.get(sessionId);

      // Associate this new socket with the existing session
      socketToSession.set(socket.id, sessionId);
      existingConnection.socketId = socket.id;

      console.log(
        `Client ${socket.id} reconnected to existing session ${sessionId}`
      );

      // Notify the client that they've reconnected to an existing session
      socket.emit("ssh-connection-exists", {
        message: "Reconnected to existing SSH session",
        sessionId: sessionId,
      });

      // Start heartbeat to keep connection alive
      startHeartbeat(socket, sessionId);

      // Ensure SSH stream is reinitialized after reconnection
      if (
        existingConnection.sshStream &&
        !existingConnection.sshStream.destroyed
      ) {
        console.log(
          `${socket.id}: Reinitializing SSH stream for session ${sessionId}`
        );
        existingConnection.sshStream.removeAllListeners();
        existingConnection.sshStream.on("data", (data) => {
          // Check data length before sending to avoid empty packets
          if (data && data.length > 0) {
            existingConnection.lastActivity = new Date();
            const stringData = data.toString("utf-8");
            console.log(
              `${socket.id}: Forwarding ${data.length} bytes of data to client`
            );

            // Wrap in try-catch to avoid any errors breaking the connection
            try {
              socket.emit("ssh-data", stringData);
            } catch (err) {
              console.error(
                `${socket.id}: Error sending data to client: ${err.message}`
              );
            }
          }
        });
        existingConnection.sshStream.stderr.on("data", (data) => {
          existingConnection.lastActivity = new Date();
          if (data && data.length > 0) {
            try {
              socket.emit("ssh-error-data", data.toString("utf-8"));
            } catch (err) {
              console.error(
                `${socket.id}: Error sending error data to client: ${err.message}`
              );
            }
          }
        });
      }
    } else {
      console.log(`Session ID ${sessionId} not found, will create new session`);
    }
  }

  // Check if a connection exists for this session
  socket.on("ssh-check-connection", (data) => {
    const sessionId = data.sessionId;

    if (sessionId && sshConnections.has(sessionId)) {
      const existingConnection = sshConnections.get(sessionId);

      // Update the socket ID for this connection
      existingConnection.socketId = socket.id;
      socketToSession.set(socket.id, sessionId);

      console.log(`Client ${socket.id} verified existing session ${sessionId}`);

      socket.emit("ssh-connection-exists", {
        message: "Existing SSH connection found",
        sessionId: sessionId,
      });
    } else {
      socket.emit("ssh-closed", {
        message: "No active SSH connection found",
      });
    }
  });

  // Handle SSH connection request
  socket.on("ssh-connect", (data) => {
    console.log(
      `SSH connection requested from ${socket.id} to ${data.username}@${data.host}:${data.port}`
    );

    const { host, port, username, privateKey, passphrase } = data;

    // Validate required parameters
    if (!host || !port || !username || !privateKey) {
      const errorMsg = "Missing required connection parameters";
      console.error(`${socket.id}: ${errorMsg}`);
      socket.emit("ssh-error", { message: errorMsg });
      return;
    }

    // Validate private key format
    let processedPrivateKey = privateKey.trim();
    if (
      !processedPrivateKey.includes("-----BEGIN") &&
      !processedPrivateKey.includes("-----END")
    ) {
      console.error(
        `${socket.id}: Invalid private key format - missing BEGIN/END markers`
      );
      socket.emit("ssh-error", {
        message:
          "Invalid private key format - please use PEM format with BEGIN/END markers",
      });
      return;
    }

    // Normalize line endings in the private key (important for SSH)
    processedPrivateKey = processedPrivateKey.replace(/\r\n/g, "\n");

    // Create a unique session ID
    const sessionId = crypto.randomUUID();
    socketToSession.set(socket.id, sessionId);

    // Create SSH client
    const sshClient = new ssh2.Client();

    // Create connection object to track state
    const connection = {
      sessionId,
      socketId: socket.id,
      sshClient,
      sshStream: null,
      host,
      port,
      username,
      created: new Date(),
      lastActivity: new Date(),
      cols: 80, // Default terminal size
      rows: 24, // Default terminal size
      authenticated: false, // Track if authentication was successful
      monitoringActive: false, // Flag to prevent duplicate monitoring
      lastCommandTime: 0, // Track when the last command was sent
    };

    // Set a strict hard timeout for authentication
    const hardAuthTimeout = setTimeout(() => {
      if (!connection.authenticated) {
        console.log(
          `${socket.id}: Hard authentication timeout reached, forcibly ending connection`
        );
        socket.emit("ssh-error", {
          message: "Authentication timeout - connection terminated",
        });

        // Force destroy the connection to prevent loops
        if (sshClient) {
          try {
            // Destroy the underlying socket forcibly
            if (sshClient._sock) {
              sshClient._sock.destroy();
            }
            sshClient.end();
          } catch (err) {
            console.error(
              `${socket.id}: Error during forced disconnection: ${err.message}`
            );
          }
        }

        cleanupConnection(socket.id, sessionId);
      }
    }, 15000); // 15 seconds hard timeout for authentication

    // Store the timeout reference for cleanup
    connection.hardAuthTimeout = hardAuthTimeout;

    // Setup SSH client event handlers
    sshClient.on("ready", () => {
      // Clear the hard auth timeout since we're authenticated
      if (connection.hardAuthTimeout) {
        clearTimeout(connection.hardAuthTimeout);
        connection.hardAuthTimeout = null;
      }

      console.log(
        `${socket.id}: SSH connection established to ${username}@${host}:${port}`
      );

      // Mark as authenticated
      connection.authenticated = true;

      // Store connection for management
      sshConnections.set(sessionId, connection);

      // Notify the client
      socket.emit("ssh-connected", {
        message: "SSH connection established successfully",
        sessionId: sessionId,
      });

      // Create shell only after successful authentication
      createShell(socket, connection);
    });

    // Handle SSH client errors
    sshClient.on("error", (err) => {
      // Clear any pending timeouts
      if (connection.hardAuthTimeout) {
        clearTimeout(connection.hardAuthTimeout);
        connection.hardAuthTimeout = null;
      }

      const errorMsg = `SSH connection error: ${err.message}`;
      console.error(`${socket.id}: ${errorMsg}`);
      socket.emit("ssh-error", { message: errorMsg });

      // Always cleanup on error to prevent auth loops
      cleanupConnection(socket.id, sessionId);
    });

    // Handle SSH client end
    sshClient.on("end", () => {
      console.log(`${socket.id}: SSH client ended`);
      socket.emit("ssh-ended", { message: "SSH connection ended" });

      // Always cleanup on end to prevent auth loops
      cleanupConnection(socket.id, sessionId);
    });

    // Handle SSH client close
    sshClient.on("close", (hadError) => {
      console.log(
        `${socket.id}: SSH client closed${hadError ? " with error" : ""}`
      );
      socket.emit("ssh-closed", {
        message: `SSH connection closed${hadError ? " with error" : ""}`,
      });

      // Always cleanup on close to prevent auth loops
      cleanupConnection(socket.id, sessionId);
    });

    // Connect to the SSH server with proper authentication
    try {
      // Build connect config - important for proper auth
      let connectConfig = {
        host,
        port: parseInt(port),
        username,
        readyTimeout: 30000, // 30 seconds timeout
        keepaliveInterval: 10000, // Send keepalive packet every 10 seconds
        keepaliveCountMax: 3, // Allow 3 missed keepalives before disconnect
        algorithms: {
          // Explicitly define supported algorithms for better compatibility
          kex: [
            "curve25519-sha256",
            "curve25519-sha256@libssh.org",
            "ecdh-sha2-nistp256",
            "ecdh-sha2-nistp384",
            "ecdh-sha2-nistp521",
            "diffie-hellman-group-exchange-sha256",
            "diffie-hellman-group14-sha1", // More compatible with older servers
          ],
          serverHostKey: [
            "ssh-rsa",
            "rsa-sha2-512",
            "rsa-sha2-256",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521",
            "ssh-ed25519",
          ],
          cipher: [
            "aes128-gcm@openssh.com",
            "aes256-gcm@openssh.com",
            "aes128-ctr",
            "aes192-ctr",
            "aes256-ctr",
            "aes128-cbc", // More compatible with older servers
            "aes256-cbc", // More compatible with older servers
          ],
          hmac: [
            "hmac-sha2-256-etm@openssh.com",
            "hmac-sha2-512-etm@openssh.com",
            "hmac-sha2-256",
            "hmac-sha2-512",
            "hmac-sha1", // More compatible with older servers
          ],
          compress: ["none", "zlib@openssh.com"],
        },
        // Set maximum number of concurrent channels - prevent SSH_MSG_CHANNEL_OPEN_FAILURE
        maxSessions: 6,
      };

      // CRITICAL: Fix for authentication issues
      if (processedPrivateKey) {
        // Use privateKey with or without passphrase
        connectConfig.privateKey = processedPrivateKey;

        // Only add passphrase if it exists
        if (passphrase && passphrase.length > 0) {
          connectConfig.passphrase = passphrase;
          console.log(`${socket.id}: Using private key with passphrase`);
        } else {
          console.log(`${socket.id}: Using private key without passphrase`);
        }
      }

      // Explicitly set auth method to avoid "no valid auth methods available"
      connectConfig.authHandler = function (
        methodsLeft,
        partialSuccess,
        callback
      ) {
        // Add null check to prevent "Cannot read properties of null (reading 'join')" error
        if (!methodsLeft || !Array.isArray(methodsLeft)) {
          console.log(
            `${socket.id}: WARNING - Auth methods list is ${
              methodsLeft === null ? "null" : "invalid"
            }, defaulting to publickey`
          );
          socket.emit(
            "ssh-data",
            `\r\n\x1b[33mWarning: Auth methods unavailable, trying default authentication\x1b[0m\r\n`
          );
          return callback("publickey");
        }

        console.log(
          `${socket.id}: Auth methods available: ${methodsLeft.join(", ")}`
        );
        socket.emit(
          "ssh-data",
          `\r\n\x1b[33mAuth methods available: ${methodsLeft.join(
            ", "
          )}\x1b[0m\r\n`
        );

        // Priority of auth method selection
        if (methodsLeft.includes("publickey")) {
          console.log(
            `${socket.id}: Selecting 'publickey' authentication method`
          );
          return callback("publickey");
        }

        if (methodsLeft.includes("keyboard-interactive")) {
          console.log(
            `${socket.id}: Selecting 'keyboard-interactive' authentication method`
          );
          return callback("keyboard-interactive");
        }

        if (methodsLeft.includes("password")) {
          console.log(
            `${socket.id}: Selecting 'password' authentication method`
          );
          return callback("password");
        }

        // If no matching method, use the first available
        console.log(
          `${socket.id}: No preferred auth methods available, using: ${
            methodsLeft[0] || "none"
          }`
        );
        callback(methodsLeft[0] || "none");
      };

      // Handle keyboard-interactive auth as fallback
      sshClient.on(
        "keyboard-interactive",
        (name, instructions, lang, prompts, finish) => {
          console.log(
            `${socket.id}: Keyboard-interactive auth initiated: ${prompts.length} prompts`
          );
          
          // Since we're using private key auth primarily, we'll respond with empty answers
          // This is a fallback mechanism in case the server requests keyboard auth
          const responses = prompts.map(() => '');
          finish(responses);
          
          // Notify client about the authentication attempt
          socket.emit(
            "ssh-data",
            `\r\n\x1b[33mAttempting keyboard-interactive authentication...\x1b[0m\r\n`
          );
        }
      );

      // Set up connection watchdog to prevent hanging connections
      const setupWatchdog = () => {
        let watchdogTimer = null;

        // Set up a watchdog to check connection status during authentication
        watchdogTimer = setInterval(() => {
          if (connection && !connection.authenticated) {
            console.log(
              `${socket.id}: Watchdog check - connection still authenticating...`
            );
            socket.emit(
              "ssh-data",
              `\r\n\x1b[33mStill trying to authenticate...\x1b[0m\r\n`
            );
          }
        }, 5000); // Check every 5 seconds during authentication

        // Register cleanup for the watchdog
        const cleanupWatchdog = () => {
          if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
          }
        };

        // Clean up the watchdog on various events
        sshClient.once("ready", cleanupWatchdog);
        sshClient.once("error", cleanupWatchdog);
        sshClient.once("end", cleanupWatchdog);
        sshClient.once("close", cleanupWatchdog);
        socket.once("disconnect", cleanupWatchdog);

        return cleanupWatchdog; // Return cleanup function
      };

      // Start watchdog
      const watchdogCleanup = setupWatchdog();

      console.log(
        `${socket.id}: Attempting SSH connection to ${username}@${host}:${port}`
      );

      // Log helpful info
      socket.emit(
        "ssh-data",
        `\r\n\x1b[33mAttempting to connect to ${username}@${host}:${port}...\x1b[0m\r\n`
      );
      socket.emit(
        "ssh-data",
        `\r\n\x1b[33mUsing private key authentication...\x1b[0m\r\n`
      );

      // Actually connect - this is where authentication happens
      sshClient.connect(connectConfig);
    } catch (error) {
      const errorMsg = `Failed to connect: ${error.message}`;
      console.error(`${socket.id}: ${errorMsg}`);
      socket.emit("ssh-error", { message: errorMsg });
      cleanupConnection(socket.id, sessionId);
    }
  });

  // Handle command execution for system monitoring - Use the queue to prevent channel saturation
  socket.on("ssh-execute-command", async (data, callback) => {
    const sessionId = socketToSession.get(socket.id);

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to execute command without an active SSH connection`
      );
      if (typeof callback === "function") {
        callback({ error: "No active SSH connection", output: "" });
      }
      return;
    }

    const connection = sshConnections.get(sessionId);
    const { sshClient } = connection;

    if (!sshClient || !connection.authenticated) {
      console.warn(
        `${socket.id}: SSH client not authenticated for command execution`
      );
      if (typeof callback === "function") {
        callback({ error: "SSH client not authenticated", output: "" });
      }
      return;
    }

    const { command, background = false } = data; // Extract background flag from request

    // Check if this is a kill command that needs special handling
    if (command.match(/^(sudo\s+)?kill\s+/)) {
      if (processKillCommand(command, socket, sessionId, connection)) {
        return; // Command handled by processKillCommand
      }
    }
    
    // Continue with normal command processing
    console.log(`${socket.id}: Queueing ${background ? 'background' : 'foreground'} command: ${command}`);

    // Apply command throttling
    const now = Date.now();
    if (now - connection.lastCommandTime < 500) {
      console.log(`${socket.id}: Command throttled, proceeding in queue`);
    }
    connection.lastCommandTime = now;

    // Add command options to connection for stream handling
    connection.options = data;
    connection.executionId = data.executionId;

    // Add to queue instead of executing directly
    cmdQueue.add({
      connection,
      command,
      callback,
      socket,
      socketId: socket.id,
      sessionId,
      background // Pass background flag to queue processor
    });
  });

  // Handle batch command execution
  socket.on("ssh-execute-batch", async (data) => {
    const { commands, batchId, sessionId, background = false } = data;

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to execute batch without an active SSH connection`
      );
      socket.emit("command-batch-result", {
        batchId,
        results: [],
        error: "No active SSH connection",
        background
      });
      return;
    }

    const connection = sshConnections.get(sessionId);

    if (!connection.sshClient || !connection.authenticated) {
      console.warn(
        `${socket.id}: SSH client not authenticated for batch execution`
      );
      socket.emit("command-batch-result", {
        batchId,
        results: [],
        error: "SSH client not authenticated",
      });
      return;
    }

    if (!commands || !Array.isArray(commands) || commands.length === 0) {
      console.warn(`${socket.id}: Empty command batch received`);
      socket.emit("command-batch-result", {
        batchId,
        results: [],
        error: "Empty command batch",
      });
      return;
    }

    console.log(
      `${socket.id}: Processing ${background ? 'background' : 'foreground'} batch of ${commands.length} commands (ID: ${batchId})`
    );

    try {
      // Execute commands in sequence with limited concurrency (3 commands at once)
      const results = [];
      const MAX_CONCURRENT = 3;
      const chunks = [];

      // Chunk commands into groups for parallel execution
      for (let i = 0; i < commands.length; i += MAX_CONCURRENT) {
        chunks.push(commands.slice(i, i + MAX_CONCURRENT));
      }

      // Process each chunk sequentially
      for (const chunk of chunks) {
        // Process commands in this chunk concurrently
        const chunkPromises = chunk.map((command) => {
          return new Promise((resolve) => {
            cmdQueue.add({
              connection,
              command,
              socket,
              socketId: socket.id,
              sessionId,
              background,
              callback: (result) => {
                resolve({
                  command,
                  output: result.output || "",
                  error: result.error || null,
                  background
                });
              },
            });
          });
        });

        // Wait for all commands in this chunk to complete
        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
      }

      // Send all results back to the client
      socket.emit("command-batch-result", {
        batchId,
        results,
        background
      });
    } catch (error) {
      console.error(`${socket.id}: Error processing batch: ${error.message}`);
      socket.emit("command-batch-result", {
        batchId,
        results: [],
        error: `Batch execution error: ${error.message}`,
      });
    }
  });

  // Handle shell restart requests
  socket.on("ssh-restart-shell", () => {
    const sessionId = socketToSession.get(socket.id);

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to restart shell without an active SSH connection`
      );
      socket.emit("ssh-error", { message: "No active SSH connection" });
      return;
    }

    const connection = sshConnections.get(sessionId);
    const { sshClient } = connection;

    if (!sshClient || !sshClient.config) {
      console.error(
        `${socket.id}: SSH client not properly initialized for restart`
      );
      socket.emit("ssh-error", {
        message: "SSH client not properly initialized",
      });
      return;
    }

    // Cancel any pending commands for this session
    cmdQueue.clearSessionCommands(sessionId);

    // Close existing stream if any
    if (connection.sshStream && !connection.sshStream.destroyed) {
      try {
        console.log(`${socket.id}: Closing existing SSH stream for restart`);
        connection.sshStream.end();
        connection.sshStream = null;
      } catch (err) {
        console.error(`${socket.id}: Error closing stream: ${err.message}`);
      }
    }

    // Wait a moment before creating a new shell
    setTimeout(() => {
      createShell(socket, connection);
    }, 300);
  });

  // Handle terminal resize events
  socket.on("ssh-resize", (data) => {
    const sessionId = socketToSession.get(socket.id);

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to resize without an active SSH connection`
      );
      return;
    }

    const connection = sshConnections.get(sessionId);

    try {
      const { cols, rows } = data;
      if (!cols || !rows || cols <= 0 || rows <= 0) {
        console.warn(
          `${socket.id}: Invalid terminal dimensions: ${cols}x${rows}`
        );
        return;
      }

      // Store current dimensions
      connection.cols = cols;
      connection.rows = rows;

      console.log(`${socket.id}: Resizing terminal to ${cols}x${rows}`);

      // If SSH stream exists, set window size
      if (connection.sshStream && !connection.sshStream.destroyed) {
        connection.sshStream.setWindow(rows, cols);
        connection.lastActivity = new Date();
      }
    } catch (err) {
      console.error(`${socket.id}: Error during resize: ${err.message}`);
    }
  });

  // Handle input from client to SSH server
  socket.on("ssh-input", (data) => {
    const sessionId = socketToSession.get(socket.id);

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to send data without an active SSH connection`
      );
      socket.emit("ssh-error", { message: "No active SSH connection" });
      return;
    }

    const connection = sshConnections.get(sessionId);
    const { sshStream } = connection;

    if (sshStream && !sshStream.destroyed) {
      // Don't log the actual content for security reasons, just the size
      console.log(`${socket.id}: Sending client input: ${data.length} bytes`);
      connection.lastActivity = new Date(); // Update last activity timestamp

      try {
        sshStream.write(data);
      } catch (err) {
        console.error(`${socket.id}: Error writing to stream: ${err.message}`);
        socket.emit("ssh-error", {
          message: `Error sending data: ${err.message}`,
        });
      }
    } else if (
      connection.sshClient &&
      connection.sshClient.config &&
      connection.authenticated
    ) {
      console.log(
        `${socket.id}: Stream not available, attempting to recreate shell`
      );
      createShell(socket, connection);

      // Queue the input to be sent after shell creation (with a small delay)
      setTimeout(() => {
        if (connection.sshStream && !connection.sshStream.destroyed) {
          try {
            connection.sshStream.write(data);
          } catch (err) {
            console.error(
              `${socket.id}: Error writing to recreated stream: ${err.message}`
            );
          }
        }
      }, 500);
    } else {
      console.warn(`${socket.id}: Tried to write to destroyed stream`);
      socket.emit("ssh-error", { message: "SSH stream is not available" });
    }
  });

  // Handle client disconnection request
  socket.on("ssh-disconnect", () => {
    console.log(`${socket.id}: Client requested disconnect`);

    const sessionId = socketToSession.get(socket.id);
    if (sessionId) {
      // Clear any monitoring and pending commands
      const connection = sshConnections.get(sessionId);
      if (connection && connection.monitoringTimer) {
        clearInterval(connection.monitoringTimer);
        connection.monitoringTimer = null;
      }

      cmdQueue.clearSessionCommands(sessionId);
      cleanupConnection(socket.id, sessionId);
    }
  });

  // Handle refresh connection request
  socket.on("ssh-refresh-connection", () => {
    const sessionId = socketToSession.get(socket.id);

    if (!sessionId || !sshConnections.has(sessionId)) {
      console.warn(
        `${socket.id}: Attempted to refresh connection without an active SSH connection`
      );
      socket.emit("ssh-error", { message: "No active SSH connection" });
      return;
    }

    const connection = sshConnections.get(sessionId);

    // If the stream is available, just send a command to refresh the view
    if (connection.sshStream && !connection.sshStream.destroyed) {
      console.log(`${socket.id}: Refreshing SSH connection view`);

      try {
        connection.sshStream.write("\n");
        connection.sshStream.write('echo "Refreshing system data..."\n');
        connection.sshStream.write("uptime\n");

        // Use the queue for a longer command to avoid channel saturation
        cmdQueue.add({
          connection,
          command: "top -bn 1 | head -20",
          socket,
          socketId: socket.id,
          sessionId,
          callback: (result) => {
            if (!result.error && result.output) {
              socket.emit("ssh-data", "\r\n" + result.output + "\r\n");
            }
          },
        });

        socket.emit(
          "ssh-data",
          "\r\n\x1b[32m# Connection refreshed\x1b[0m\r\n"
        );
      } catch (err) {
        console.error(`${socket.id}: Error during refresh: ${err.message}`);
        // If we hit an error, try recreating the shell
        setTimeout(() => createShell(socket, connection), 500);
      }
    } else {
      // If no stream is available, create a new shell
      console.log(
        `${socket.id}: No stream available, creating new shell on refresh`
      );
      createShell(socket, connection);
    }
  });

  // Handle socket disconnection (browser tab close, refresh, etc.)
  socket.on("disconnect", () => {
    console.log(`${socket.id}: Client socket disconnected (may be temporary)`);

    // Stop heartbeat
    if (socket.heartbeatInterval) {
      clearInterval(socket.heartbeatInterval);
      socket.heartbeatInterval = null;
    }

    // We'll let the session expiry cleaner handle abandoned sessions
  });
});

// System maintenance and monitoring functions
const runMemoryCheck = () => {
  const memoryUsage = process.memoryUsage();
  console.log(
    `Memory usage: RSS: ${Math.round(
      memoryUsage.rss / 1024 / 1024
    )}MB, Heap Used: ${Math.round(
      memoryUsage.heapUsed / 1024 / 1024
    )}MB / ${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`
  );

  // If memory usage is high, perform cleanup
  if (memoryUsage.heapUsed > 800 * 1024 * 1024) {
    // 800MB
    console.log("High memory usage detected, cleaning up connections");

    // Force cleanup of all connections that aren't authenticated
    for (const [sessionId, connection] of sshConnections.entries()) {
      if (!connection.authenticated) {
        console.log(
          `Memory cleanup: removing unauthenticated session ${sessionId}`
        );

        // Clean up the connection
        if (connection.sshStream && !connection.sshStream.destroyed) {
          connection.sshStream.destroy();
        }

        if (connection.sshClient) {
          if (connection.sshClient._sock) {
            connection.sshClient._sock.destroy();
          }
          connection.sshClient.end();
        }

        // Remove the session
        sshConnections.delete(sessionId);

        // Remove any socket associations for this session
        for (const [socketId, sid] of socketToSession.entries()) {
          if (sid === sessionId) {
            socketToSession.delete(socketId);
          }
        }
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      console.log("Forcing garbage collection");
      global.gc();
    }
  }
};

const cleanExpiredSessions = () => {
  const now = new Date();
  const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

  console.log(
    `Session cleaner: checking ${sshConnections.size} active sessions`
  );

  for (const [sessionId, connection] of sshConnections.entries()) {
    const lastActivityTime = connection.lastActivity.getTime();
    const elapsedMs = now.getTime() - lastActivityTime;

    if (elapsedMs > SESSION_EXPIRY_MS) {
      console.log(
        `Session cleaner: removing inactive session ${sessionId} (${
          connection.username
        }@${connection.host}), inactive for ${Math.floor(
          elapsedMs / 1000 / 60
        )} minutes`
      );

      // Clean up monitoring resources
      if (connection.monitoringTimer) {
        clearInterval(connection.monitoringTimer);
        connection.monitoringTimer = null;
      }

      // Clean up high frequency monitoring
      if (connection.highFreqMonitoringTimer) {
        clearInterval(connection.highFreqMonitoringTimer);
        connection.highFreqMonitoringTimer = null;
      }

      // Clean up the connection
      if (connection.sshStream && !connection.sshStream.destroyed) {
        connection.sshStream.destroy();
      }

      if (connection.sshClient) {
        if (connection.sshClient._sock) {
          connection.sshClient._sock.destroy();
        }
        connection.sshClient.end();
      }

      // Remove the session
      sshConnections.delete(sessionId);

      // Remove any socket associations for this session
      for (const [socketId, sid] of socketToSession.entries()) {
        if (sid === sessionId) {
          socketToSession.delete(socketId);
        }
      }
    }
  }
};

// Set up system maintenance intervals
const MEMORY_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
setInterval(runMemoryCheck, MEMORY_CHECK_INTERVAL);

// Set up session expiry checker
setInterval(cleanExpiredSessions, 10 * 60 * 1000); // Run every 10 minutes

// Basic health check endpoint
app.get("/health", (req, res) => {
  const queueState = cmdQueue.getQueueState();
  res.status(200).json({
    status: "ok",
    connections: sshConnections.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    queuedCommands: queueState.queue,
    runningCommands: queueState.running,
  });
});

// Start the server
const PORT = process.env.PORT || process.env.SSH_SERVER_PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`SSH Server listening on ${HOST}:${PORT}`);
});

// Enable garbage collection runs if using the --expose-gc flag
if (global.gc) {
  console.log("Garbage collection available");

  // Run garbage collection every 5 minutes
  setInterval(() => {
    console.log("Running manual garbage collection");
    global.gc();
  }, 5 * 60 * 1000);
}

// Handle server shutdown
process.on("SIGINT", () => {
  console.log("Shutting down SSH server...");

  // Close all SSH connections
  for (const [sessionId, connection] of sshConnections.entries()) {
    console.log(`Closing SSH connection for ${sessionId}`);

    if (connection.hardAuthTimeout) {
      clearTimeout(connection.hardAuthTimeout);
    }

    if (connection.monitoringTimer) {
      clearInterval(connection.monitoringTimer);
    }

    if (connection.highFreqMonitoringTimer) {
      clearInterval(connection.highFreqMonitoringTimer);
    }

    if (connection.sshStream && !connection.sshStream.destroyed) {
      connection.sshStream.destroy();
    }

    if (connection.sshClient) {
      if (connection.sshClient._sock) {
        connection.sshClient._sock.destroy();
      }
      connection.sshClient.end();
    }
  }

  sshConnections.clear();
  socketToSession.clear();

  // Close server
  server.close(() => {
    console.log("SSH server shut down.");
    process.exit(0);
  });
});

// Validasi kill command dan cek hasilnya
const processKillCommand = (command, socket, sessionId, connection) => {
  const killMatch = command.match(/^(sudo\s+)?kill\s+(-[0-9]+)\s+([0-9]+)$/);
  if (killMatch) {
    const isSudo = !!killMatch[1];
    const signal = parseInt(killMatch[2].substring(1));
    const pid = parseInt(killMatch[3]);
    
    console.log(`${socket.id}: Processing kill command for PID ${pid} with signal ${signal}`);
    
    cmdQueue.add({
      connection,
      command,
      socket,
      socketId: socket.id,
      sessionId,
      callback: (result) => {
        if (result.error) {
          console.error(`${socket.id}: Kill command failed: ${result.error}`);
          
          // Check if error suggests permission issues
          const needsElevation = result.errorOutput && 
                               (result.errorOutput.includes('Operation not permitted') || 
                                result.errorOutput.includes('Permission denied'));
          
          socket.emit("command-error", {
            command,
            error: result.error,
            needsElevation
          });
          
          // Jika butuh elevasi, beri tahu client
          if (needsElevation) {
            socket.emit("ssh-data", `\r\n\x1b[31mError: Need sudo privileges to kill this process.\x1b[0m\r\n`);
          }
        } else {
          console.log(`${socket.id}: Successfully killed process ${pid}`);
          
          // Verifikasi process sudah mati
          cmdQueue.add({
            connection,
            command: `ps -p ${pid} > /dev/null 2>&1; echo $?`,
            socketId: socket.id,
            sessionId,
            background: true,
            callback: (checkResult) => {
              const isKilled = !checkResult.error && checkResult.output.trim() !== "0";
              
              socket.emit("process-killed", { 
                pid,
                success: isKilled
              });
              
              if (!isKilled) {
                socket.emit("ssh-data", `\r\n\x1b[33mWarning: Process ${pid} may still be running.\x1b[0m\r\n`);
              } else {
                socket.emit("ssh-data", `\r\n\x1b[32mSuccess: Process ${pid} terminated.\x1b[0m\r\n`);
              }
              
              // Minta refresh data process segera
              cmdQueue.add({
                connection,
                command: "ps aux --sort=-%cpu | head -20",
                socketId: socket.id,
                sessionId,
                background: true,
                callback: (stats) => {
                  if (!stats.error) {
                    socket.emit("process-stats-update", { data: stats.output });
                  }
                }
              });
            }
          });
        }
      }
    });
    
    return true; // Indicate we've handled this command
  }
  
  return false; // Not a kill command
};