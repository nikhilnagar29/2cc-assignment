# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Change 1: Copy package.json from the 'src' directory
COPY src/package*.json ./

# This will now find the package.json and run correctly
RUN npm install --omit=dev

# Change 2: Copy the *entire* 'src' directory content
# This copies server.js and everything else into /usr/src/app
COPY ./src ./

# --- Stage 2: Final Image ---
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy the built app (with node_modules) from the 'builder' stage
COPY --from=builder /usr/src/app .

EXPOSE 3000

# Change 3: The CMD now runs 'server.js' from the root
# (not 'src/server.js', since we copied its content up)
CMD [ "node", "server.js" ]