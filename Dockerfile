FROM node:20-bullseye AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . ./
RUN npm run build

FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openjdk-17-jdk \
    unzip \
    zip \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

ENV GRADLE_VERSION=8.7
RUN curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip \
  && unzip -q /tmp/gradle.zip -d /opt \
  && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
  && rm /tmp/gradle.zip

ENV ANDROID_SDK_ROOT=/opt/android-sdk

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools \
  && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip -o /tmp/android-tools.zip \
  && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
  && mv /tmp/android-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest \
  && rm -rf /tmp/android-tools /tmp/android-tools.zip

ENV PATH="${PATH}:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools"

RUN mkdir -p /root/.android \
  && touch /root/.android/repositories.cfg \
  && yes | sdkmanager --sdk_root=${ANDROID_SDK_ROOT} --licenses \
  && sdkmanager --sdk_root=${ANDROID_SDK_ROOT} \
    "platform-tools" \
    "platforms;android-34" "build-tools;34.0.0" \
    "platforms;android-33" "build-tools;33.0.2" \
    "platforms;android-32" "build-tools;32.0.0" \
    "platforms;android-31" "build-tools;31.0.0" \
    "platforms;android-30" "build-tools;30.0.3"

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]