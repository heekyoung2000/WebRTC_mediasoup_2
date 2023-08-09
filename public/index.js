//index.js
const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client')

const roomName = window.location.pathname.split('/')[2]

const socket = io("/mediasoup");
const dataSocket = io("/data");

socket.on('connection-success', ({ socketId }) => {
    console.log(socketId)
    getLocalStream()
})

dataSocket.on('connection-success', ({ socketId }) => {
    console.log("data 소켓: ", socketId);
})

window.addEventListener("beforeunload", function () {
    // 클라이언트가 인터넷 창을 닫기 전에 서버로 disconnect 이벤트를 전송
    socket.emit("disconnect");
    dataSocket.emit("disconnect");
});

let device
let rtpCapabilities
let producerTransport
let consumerTransports = []
let videoProducer
let audioProducer

let params = {
    // mediasoup params
    encodings: [
        {
            rid: 'r0',
            maxBitrate: 100000,
            scalabilityMode: 'S1T3',
        },
    ],
    codecOptions: {
        videoGoogleStartBitrate: 300
    }
}

let audioParams;
let videoParams = { params };
let consumingTransports = [];

const streamSuccess = (stream) => {
    localVideo.srcObject = stream;

    //🔊오디오 추가
    audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
    videoParams = { track: stream.getVideoTracks()[0], ...videoParams };
    joinRoom()
}

const joinRoom = () => {
    socket.emit('joinRoom', { roomName }, (data) => {
        console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)
        rtpCapabilities = data.rtpCapabilities
        createDevice()
    })
}

const getLocalStream = () => {
    navigator.mediaDevices.getUserMedia({
        //🔊오디오 추가
        audio: true,
        video: {
            width: {
                min: 640,
                max: 1920,
            },
            height: {
                min: 400,
                max: 1080,
            }
        }
    })
        .then(streamSuccess)
        .catch(error => {
            console.log(error.message)
        })
}

const createDevice = async () => {
    try {
        device = new mediasoupClient.Device()

        await device.load({
            routerRtpCapabilities: rtpCapabilities
        })

        console.log('Device RTP Capabilities', device.rtpCapabilities)
        createSendTransport()

    } catch (error) {
        console.log(error)
        if (error.name === 'UnsupportedError')
            console.warn('browser not supported')
    }
}

/*Send Transport를 생성하는 함수로 클라이언트 측에서 소켓 통신을 통해 서버에 send Transport생성을 요청하고, 
서버로 부터 필요한 매개변수를 받아와 send Transport를 생성한다.*/
const createSendTransport = () => { //
    socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
        if (params.error) {
            console.log(params.error)
            return
        }

        console.log(params)

        producerTransport = device.createSendTransport(params) //서버로부터 받은 'params'를 사용하여 mediasoup의 'device.createSendTranasport()' 메서드를 호출하여 Send Transport 객체를 생성

        producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => { //클라이언트 측에서 서버에 dtls 매개변수를 전달하기 위해 사용
            try {
                await socket.emit('transport-connect', {
                    dtlsParameters,
                })

                callback()

            } catch (error) {
                errback(error)
            }
        })

        producerTransport.on('produce', async (parameters, callback, errback) => {
            console.log(parameters)

            try {
                await socket.emit('transport-produce', {
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData,
                }, ({ id, producersExist }) => {
                    callback({ id })

                    if (producersExist) getProducers()
                })
            } catch (error) {
                errback(error)
            }
        })

        connectSendTransport()
    })
}

const connectSendTransport = async () => {
   
    //🔊오디오 추가
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

    await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
        if (params.error) {
            console.log(params.error)
            return
        }
        console.log(`PARAMS... ${params}`)

        let consumerTransport
        try {
            consumerTransport = device.createRecvTransport(params)
        } catch (error) {
            console.log(error)
            return
        }

        consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await socket.emit('transport-recv-connect', {
                    dtlsParameters,
                    serverConsumerTransportId: params.id,
                })

                callback()
            } catch (error) {
                errback(error)
            }
        })

        connectRecvTransport(consumerTransport, remoteProducerId, params.id)
    })
}

socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))

const getProducers = () => {
    socket.emit('getProducers', producerIds => {
        console.log(producerIds)
        producerIds.forEach(signalNewConsumerTransport)
    })
}

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
    await socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
    }, async ({ params }) => {
        if (params.error) {
            console.log('Cannot Consume')
            return
        }

        console.log(`Consumer Params ${params}`)
        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        })

        consumerTransports = [
            ...consumerTransports,
            {
                consumerTransport,
                serverConsumerTransportId: params.id,
                producerId: remoteProducerId,
                consumer,
            },
        ]

        const newElem = document.createElement('div')
        newElem.setAttribute('id', `td-${remoteProducerId}`)

        if (params.kind == 'audio') {
            //append to the audio container
            newElem.innerHTML = '<audio id="' + remoteProducerId + '" autoplay></audio>'
        } else{
             newElem.setAttribute('class', 'remoteVideo')
        newElem.innerHTML = '<video id="' + remoteProducerId + '" autoplay class="video" ></video>'
        }
        videoContainer.appendChild(newElem)

        const { track } = consumer

        document.getElementById(remoteProducerId).srcObject = new MediaStream([track])

        socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId })
    })
}

socket.on('producer-closed', ({ remoteProducerId }) => {
    const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
    producerToClose.consumerTransport.close()
    producerToClose.consumer.close()

    consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)
    videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`))
})

