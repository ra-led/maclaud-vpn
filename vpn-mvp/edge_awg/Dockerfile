FROM golang:1.24-bookworm AS awg-go-builder

RUN git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git /src/amneziawg-go
WORKDIR /src/amneziawg-go
RUN go build -v -o /out/amneziawg-go

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common python3-launchpadlib gnupg2 ca-certificates curl iproute2 iptables qrencode \
    && add-apt-repository -y ppa:amnezia/ppa \
    && apt-get update \
    && (apt-get install -y --no-install-recommends amneziawg-tools || apt-get install -y --no-install-recommends amneziawg) \
    && rm -rf /var/lib/apt/lists/*

COPY --from=awg-go-builder /out/amneziawg-go /usr/local/bin/amneziawg-go
COPY entrypoint.sh /usr/local/bin/awg-docker-entrypoint

RUN chmod 755 /usr/local/bin/amneziawg-go /usr/local/bin/awg-docker-entrypoint

ENTRYPOINT ["awg-docker-entrypoint"]
