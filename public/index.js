const io = require("socket.io-client");
const mediasoupClient = require('mediasoup-client');
const socket = io("/mediasoup");

const roomName = window.location.pathname.split("/")[2];


socket.on("connection-success", ({socketId}) => {
    console.log(socketId);
    getLocalStream();
})

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransports = [];
let audioProducer;
let videoProducer;
let consumer;
let isProducer = false;

let params = {
    encoding: [
        {
            rid: "r0",
            maxBitrate: 100000,
            scalabilityMode: "S1T3",
        },
        {
            rid: "r1",
            maxBitrate: 300000,
            scalabilityMode: "S1T3",
        },
        {
            rid: "r2",
            maxBitrate: 900000,
            scalabilityMode: "S1T3",
        },
    ],
    codecOptions: {
        videoGoogleStartBitrate: 1000
    }
}


let audioParams;
let videoParams = { params };
let consumingTransports = [];

const streamSuccess = (stream) => {
    localVideo.srcObject = stream;
    audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
    videoParams = { track: stream.getVideoTracks()[0], ...videoParams };

    joinRoom();
}

const joinRoom = () => {
    socket.emit("joinRoom", { roomName }, (data) => {
        console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);

        rtpCapabilities = data.rtpCapabilities;

        createDevice();
    })
}


const getLocalStream = () => {
    navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
            width: {
                min: 640,
                max: 1920,
            },
            heigh: {
                min: 400,
                max: 1080,
            }
        }
    })
        .then(streamSuccess)
        .catch(error => {
        console.log(error.message);
    });
}

const createDevice = async () => {
    try {
        device = new mediasoupClient.Device();

        await device.load({
            routerRtpCapabilities: rtpCapabilities
        });

        console.log("Device RTP Capabilities", device.rtpCapabilities);

        createSendTransport();
    } catch (error) {
        console.log(error);
        if (error.name === "UnsupportedError")
            console.warn("browser not supported");
    }
}

socket.on("new-producer", ({ producerId }) => signalNewConsumerTransport(producerId));

const getProducers = () => {
    socket.emit("getProducers", producerIds => {
        console.log(producerIds);
        producerIds.forEach(signalNewConsumerTransport);
    })
}

const createSendTransport = () => {
    socket.emit("createWebRtcTransport", { consumer: false }, ({ params }) => {
        if (params.error) {
            console.log(params.error);
            return;
        }

        console.log(params);

        producerTransport = device.createSendTransport(params);
        producerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
                await socket.emit("transport-connect", {
                    // transportId: producerTransport.id,
                    dtlsParameters: dtlsParameters,
                })

                callback();
            } catch (error) {
                errback(error);
            }
        })

        producerTransport.on("produce", async (parameters, callback, errback) => {
            console.log(parameters);

            try {
                await socket.emit("transport-produce", {
                    // transportId: producerTransport.id,
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData,
                }, ({ id, producersExist }) => {
                    callback({ id });

                    if (producersExist) getProducers();
                })
            } catch (error) {
                errback(error);
            }
        })

        connectSendTransport();
    })


}

const connectSendTransport = async () => {
    audioProducer = await producerTransport.produce(audioParams);
    videoProducer = await producerTransport.produce(videoParams);
    audioProducer.on('trackended', () => {
        console.log('audio track ended')

        // close audio track
    })

    audioProducer.on('transportclose', () => {
        console.log('audio transport ended')

        // close audio track
    })

    videoProducer.on('trackended', () => {
        console.log('video track ended')

        // close video track
    })

    videoProducer.on('transportclose', () => {
        console.log('video transport ended')

        // close video track
    })
}

const signalNewConsumerTransport = async (remoteProducerId) => {
    if (consumingTransports.includes(remoteProducerId)) return;
    consumingTransports.push(remoteProducerId);

    await socket.emit("createWebRtcTransport", { consumer: true }, ({ params }) => {
        if (params.error) {
            console.log(params.error)
            return;
        }

        console.log(`PARAMS... ${params}`);

        let consumerTransport;

        try {
            consumerTransport = device.createRecvTransport(params);
        } catch (error) {
            console.log(error);
            return;
        }

        consumerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
                await socket.emit("transport-recv-connect", {
                    // transportId: consumerTransport.id,
                    dtlsParameters,
                    serverConsumerTransportId: params.id,
                })
                callback();
            } catch (error) {
                errback(error);
            }
        })

        connectRecvTransport(consumerTransport, remoteProducerId, params.id);
    })
}

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
    await socket.emit("consume", {
        rtpCapabilities: device.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
    }, async ({ params }) => {
        if (params.error) {
            console.log("Cannot Consume");
            return;
        }
        console.log(`Consumer Params ${params}`)

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        })

        consumerTransport = [
            ...consumerTransports,
            {
                consumerTransport,
                serverConsumerTransportId: params.id,
                producerId: remoteProducerId,
                consumer,
            }
        ]

        const newElem = document.createElement("div");
        newElem.setAttribute("id", `td-${remoteProducerId}`);
        if (params.kind == 'audio') {
            //append to the audio container
            newElem.innerHTML = '<audio id="' + remoteProducerId + '" autoplay></audio>'
        } else {
            //append to the video container
            newElem.setAttribute('class', 'remoteVideo')
            newElem.innerHTML = '<video id="' + remoteProducerId + '" autoplay class="video" ></video>'
        }
        videoContainer.appendChild(newElem);

        const { track } = consumer;

        document.getElementById(remoteProducerId).srcObject = new MediaStream([track]);
        // remoteVideo.srcObject = new MediaStream([track]);

        // socket.emit("consumer-resume");
        socket.emit("consumer-resume", { serverConsumerId: params.serverConsumerId });
    })
}

socket.on("producer-closed", ({ remoteProducerId }) => {
    const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId);
    producerToClose.consumerTransport.close();
    producerToClose.consumer.close();

    consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId);

    videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`));
})











// btnLocalVideo.addEventListener('click', getLocalStream);
// btnRtpCapabilities.addEventListener('click', getRtpCapabilities);
// btnDevice.addEventListener('click', createDevice);
// btnCreateSendTransport.addEventListener('click', createSendTransport);
// btnConnectSendTransport.addEventListener('click', connectSendTransport);
// btnRecvSendTransport.addEventListener('click', goConsume);
// btnConnectRecvTransport.addEventListener('click', connectRecvTransport);