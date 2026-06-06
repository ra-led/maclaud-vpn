FROM ubuntu:24.04

WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common python3 python3-pip python3-launchpadlib gnupg2 ca-certificates curl iproute2 iptables qrencode util-linux \
    && add-apt-repository -y ppa:amnezia/ppa \
    && apt-get update \
    && (apt-get install -y --no-install-recommends amneziawg-tools || apt-get install -y --no-install-recommends amneziawg) \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt

COPY awg-new-client /usr/local/sbin/awg-new-client
COPY app ./app
RUN chmod 755 /usr/local/sbin/awg-new-client

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]
