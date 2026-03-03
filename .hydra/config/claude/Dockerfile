FROM hydra-agent-claude:latest

RUN wget -qO- https://go.dev/dl/go1.26.0.linux-amd64.tar.gz | tar -C /usr/local -xz

# Configure Go environment variables
ENV PATH="/usr/local/go/bin:${PATH}"
