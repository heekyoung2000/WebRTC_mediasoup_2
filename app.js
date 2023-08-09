import express from "express";
import http from "http";
import path from "path";
import bodyParser from 'body-parser';
import { Server } from "socket.io";
import mediasoup from 'mediasoup';
import cors from "cors";
import routes from "./routers/router.js";
import { config } from 'dotenv';
import AWS from 'aws-sdk';

config();

//변수 설정
let worker;
let peers = {};
let transports = [];
let producers = [];
let consumers = [];
let gameMode;
let rooms = {};

const __dirname = path.resolve();
const app = express();

app.use(cors());

app.use(express.json());

app.use(bodyParser.json());

app.use("/", routes(rooms, gameMode));


// 서버, mediasoup 설정
const httpServer = http.createServer(app);
httpServer.listen(3000, () => {
    console.log("Listening on port: http://localhost:3000");
});
//cors 설정
const io = new Server(httpServer, {
    cors: {
        origin: "*"
    }
});
const connections = io.of("/mediasoup");
const dataConnections = io.of("/data");


// Worker 생성 함수
const createWorker = async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 3000,
    })
    console.log(`worker pid ${worker.pid}`);

    worker.on("died", error => {
        console.error("mediasoup worker has died");
        setTimeout(() => process.exit(1), 2000);
    })
    return worker;
}

// mediasoup worker 생성
worker = createWorker();


// 사용할 오디오 및 비디오 코덱 정의
const mediaCodecs = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
    },

    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
            "x-google-start-bitrate": 300,
            "max-fs": 3600,
            "max-br": 500
        },
    },
];

// peers 객체에서 소켓을 이용한 이벤트 처리
connections.on("connection", async socket => {
    console.log(socket.id);
    socket.emit("connection-success", {
        socketId: socket.id,
    });

    const removeItems = (items, socketId, type) => {
        items.forEach(item => {
            if (item.socketId === socket.id) {
                item[type].close();
            }
        })
        items = items.filter(item => item.socketId !== socket.id);

        return items;
    }


    socket.on("disconnect", () => {
        console.log("peer disconnected");
        consumers = removeItems(consumers, socket.id, "consumer");
        producers = removeItems(producers, socket.id, "producer");
        transports = removeItems(transports, socket.id, "transport");

        const { roomName } = peers[socket.id];

        if (roomName && rooms[roomName]) {
            rooms[roomName].peers = rooms[roomName].peers.filter(socketId => socketId !== socket.id);
            for (const room in rooms) {
                if (rooms[room].peers.length === 0) {
                    delete rooms[room];
                }
            }
        }
        delete peers[socket.id];

        console.log(rooms);
    });


    socket.on("joinRoom", async ({ roomName }, callback) => {
        const router1 = await createRoom(roomName, socket.id);

        peers[socket.id] = {
            socket,
            roomName,
            transports: [],
            producers: [],
            consumers: [],
            peerDetails: {
                name: '',
                isAdmin: false,
            }
        }
        console.log();
        console.log(rooms);
        for (const room in rooms) {
            const name = room;
            let roomLen = rooms[room].peers.length;

            console.log(`방 이름 : ${name}, 참여 인원 : ${roomLen} 명`);
        }
        console.log();

        const rtpCapabilities = router1.rtpCapabilities;

        callback({ rtpCapabilities });
    });

    const createRoom = async (roomName, socketId) => {
        let router1;
        let peers = [];
        if (rooms[roomName]) {
            router1 = rooms[roomName].router;
            peers = rooms[roomName].peers || [];
            rooms[roomName] = {
                router: router1,
                peers: [...peers, socketId],
                roomType: rooms[roomName].roomType
            }


        } else {
            router1 = await worker.createRouter({ mediaCodecs, });
            rooms[roomName] = {
                router: router1,
                peers: [...peers, socketId],
                roomType: gameMode
            }
        }

        console.log(`Router ID: ${router1.id}`, peers.length);

        return router1;
    }
    // transport 생성
    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
        const roomName = peers[socket.id].roomName;

        const router = rooms[roomName].router;

        createWebRtcTransport(router).then(
            transport => {
                callback({
                    params: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    }
                })

                addTransport(transport, roomName, consumer);
            },
            error => {
                console.log(error);
            });
    })

    const addTransport = (transport, roomName, consumer) => {
        transports = [
            ...transports,
            { socketId: socket.id, transport, roomName, consumer, }
        ]

        peers[socket.id] = {
            ...peers[socket.id],
            transports: [
                ...peers[socket.id].transports,
                transport.id,
            ]

        }
    }

    const addProducer = (producer, roomName) => {
        producers = [
            ...producers,
            { socketId: socket.id, producer, roomName, }
        ]
        peers[socket.id] = {
            ...peers[socket.id],
            producers: [
                ...peers[socket.id].producers,
                producer.id,
            ]
        }
    }

    const addConsumer = (consumer, roomName) => {
        consumers = [
            ...consumers,
            { socketId: socket.id, consumer, roomName, }
        ]

        peers[socket.id] = {
            ...peers[socket.id],
            consumers: [
                ...peers[socket.id].consumers,
                consumer.id,
            ]
        }
    }

    socket.on("getProducers", callback => {
        const { roomName } = peers[socket.id];

        let producerList = [];
        producers.forEach(producerData => {
            if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
                producerList = [...producerList, producerData.producer.id];
            }
        })

        callback(producerList);
    })


    // 만들어진 transport 연결
    socket.on("transport-connect", ({ dtlsParameters }) => {
        console.log("DTLS PARAMS...", { dtlsParameters });
        getTransport(socket.id).connect({ dtlsParameters });
    })

    const getTransport = (socketId) => {
        const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer);
        return producerTransport.transport;
    }

    socket.on("transport-produce", async ({ kind, rtpParameters, appData }, callback) => {
        const producer = await getTransport(socket.id).produce({
            kind,
            rtpParameters,
        })

        if (!peers[socket.id]) {
            return;
        }

        const { roomName } = peers[socket.id];

        addProducer(producer, roomName);

        informConsumers(roomName, socket.id, producer.id);

        console.log("Producer ID: ", producer.id, producer.kind)

        producer.on("transportclose", () => {
            console.log("transport for this producer closed");
            producer.close();
        })

        callback({
            id: producer.id,
            producersExist: producers.length > 1 ? true : false
        })
    })

    const informConsumers = (roomName, socketId, id) => {
        console.log(`just joined, id ${id} ${roomName}, ${socketId}`);

        producers.forEach(producerData => {
            if (producerData.socketId !== socketId && producerData.roomName === roomName) {
                const producerSocket = peers[producerData.socketId].socket;

                producerSocket.emit("new-producer", { producerId: id });
            }
        })
    }

    socket.on("transport-recv-connect", async ({ dtlsParameters, serverConsumerTransportId }) => {
        console.log(`DTLS PARAMS: ${dtlsParameters}`);
        const consumerTransport = transports.find(transportData => (
            transportData.consumer && transportData.transport.id == serverConsumerTransportId
        )).transport
        await consumerTransport.connect({ dtlsParameters });
    });

    socket.on("consume", async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
        try {
            const { roomName } = peers[socket.id];
            const router = rooms[roomName].router;
            let consumerTransport = transports.find(transportData => (
                transportData.consumer && transportData.transport.id == serverConsumerTransportId
            )).transport

            if (router.canConsume({
                producerId: remoteProducerId,
                rtpCapabilities
            })) {
                const consumer = await consumerTransport.consume({
                    producerId: remoteProducerId,
                    rtpCapabilities,
                    paused: true,
                })

                consumer.on("transportclose", () => {
                    console.log("transport close from consumer");
                })
                consumer.on("producerclose", () => {
                    console.log("producer of consumer closed");
                    socket.emit("producer-closed", { remoteProducerId });

                    consumerTransport.close([]);
                    transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id);
                    consumer.close();
                    consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id);
                });

                addConsumer(consumer, roomName);

                const params = {
                    id: consumer.id,
                    producerId: remoteProducerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    serverConsumerId: consumer.id,
                }

                callback({ params });
            }
        } catch (error) {
            console.log(error.message);
            callback({
                params: {
                    error: error
                }
            })
        }
    })

    socket.on("consumer-resume", async ({ serverConsumerId }) => {
        console.log("consumer resume");
        const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId);
        await consumer.resume();
    })
});

const createWebRtcTransport = async (router) => {
    return new Promise(async (resolve, reject) => {
        try {
            const webRtcTransport_options = {
                listenIps: [
                    {
                        ip: '172.31.5.109', //0.0.0.0 replace with relevant IP address
                        announcedIp: '43.201.47.117', //127.0.0.1
                    }
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            }
            // router 내장함수 createWebRtpTransport 함수를 실행
            let transport = await router.createWebRtcTransport(webRtcTransport_options);
            console.log(`transport id: ${transport.id}`);

            // transport 객체에 이벤트 핸들러 부착
            transport.on("dtlsstatechange", dtlsState => {
                if (dtlsState === "closed") {
                    transport.close();
                }
            });

            transport.on("close", () => {
                console.log("transport closed");
            });

            resolve(transport);
        } catch (error) {
            reject(error);
        }
    })
}

// data 소켓
dataConnections.on("connect", async socket => {
    console.log("data 소켓 연결");
    socket.emit("connection-success", {
        socketId: socket.id,
    });

    socket.on("get_game_data", (data) => {
        socket.broadcast.emit("send_game_data", {data },() => {
            console.log("success: send data")
        })
    })

    socket.on("disconnect", () => {
        console.log("data 소켓 연결 종료");
    });
})

