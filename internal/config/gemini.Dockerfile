# syntax=docker/dockerfile:1
FROM hydra-base:latest

# Install Gemini CLI.
RUN npm install -g @google/gemini-cli
