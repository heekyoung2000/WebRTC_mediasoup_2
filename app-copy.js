/**
 * integrating mediasoup server with a node.js application
 */

/* Please follow mediasoup installation requirements */
/* https://mediasoup.org/documentation/v3/mediasoup/installation/ */
import express from 'express'
const app = express()

import fs from 'fs'
import https from 'httpolyglot'
import path from 'path'
const __dirname = path.resolve()

import { Server } from 'socket.io'
import mediasoup from 'mediasoup'
import dotenv from "dotenv"
dotenv.config()


app.get('*', (req, res, next) => {
  const path = '/sfu/'

  if (req.path.indexOf(path) == 0 && req.path.length > path.length) return next()

  res.send(`You need to specify a room name in the path e.g. 'https://127.0.0.1/sfu/room'`)
})

//SSL cert for HTTPS access
const options = {
  key: fs.readFileSync('./server/ssl/key.pem','utf-8'),
  cert : fs.readFileSync('./server/ssl/cert.pem','utf-8')
}

app.use('/sfu/:room', express.static(path.join(__dirname, 'public')))


const httpsServer = https.createServer(options,app)
httpsServer.listen(3000, () => {
  console.log('listening on port: ' + 3000)
})

const io = new Server(httpsServer)

// socket.io namespace (could represent a room?)
const connections = io.of('/mediasoup')

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer 
 **/
let worker
let rooms = {}          // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}          // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []     // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []      // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []      // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {// worker(rooms이 모두 모여있는 곳)을 생성하고 포트번호를 설정해서 들어올 수 있는 사용자의 수를 제한
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2100,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    // This implies something serious happened, so kill the application
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

// We create a Worker as soon as our application starts
worker = createWorker() //웹 시작 후 worker 생성

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
const mediaCodecs = [ //RtpCapabilities의 배열로 이 안에는 미디어,비디오 코덱 정보가 들어 있음
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
]

connections.on('connection', async socket => {
  console.log(`😁소켓 통신 성공${socket.id}`)
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  const removeItems = (items, socketId, type) => {
    items.forEach(item => {
      if (item.socketId === socket.id) {
        item[type].close()
      }
    })
    items = items.filter(item => item.socketId !== socket.id)

    return items
  }

  socket.on('disconnect', () => { //disconnect를 함 이때 차례대로 consumer와 producer, transport를 제거함
    // do some cleanup
    console.log('❌❌❌peer disconnected')
    consumers = removeItems(consumers, socket.id, 'consumer') // 배열에서 socketID와 일치하는 consumer를 제거하고 변경된 'consumer'의 배열을 다시 할당
    producers = removeItems(producers, socket.id, 'producer') // 배열에서 socketID와 일치하는 producer를 제거하고 변경된 'producer'의 배열을 다시 할당
    transports = removeItems(transports, socket.id, 'transport')// 배열에서 socketID와 일치하는 transports를 제거하고 변경된 'transports'의 배열을 다시 할당

    const { roomName } = peers[socket.id] //peers 데이터 구조에서도 해당 socketID를 삭제하고, roomName에 대응하는 rooms 데이터 구조에서도 해당 소켓 ID 제거
    delete peers[socket.id]

    // remove socket from room
    rooms[roomName] = { 
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
    }
  })

  socket.on('joinRoom', async ({ roomName }, callback) => { // 클라이언트에서 joinroom 이벤트를 서버에 전송했을 떄 호출되는 이벤트 핸들러 
    // create Router if it does not exist
    // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    const router1 = await createRoom(roomName, socket.id) //room 하나에 router 1개 할당

    peers[socket.id] = { //현재 socket, 방이름, transports, producer,consumers,
      socket,
      roomName,           // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: '',
        isAdmin: false,   // Is this Peer the Admin?
      }
    }

    // get Router RTP Capabilities - 클라이언트로부터 전달한 rtp 기능을 나타냄
    const rtpCapabilities = router1.rtpCapabilities

    // call callback from the client and send back the rtpCapabilities - 클라이언트 콜백 함수를 호출하고 rtpcapabilites를 인수로 전달하여 서버에서 클라이언트로 rtp 기능을 전달
    callback({ rtpCapabilities })
  })

  const createRoom = async (roomName, socketId) => { //방이름과 소켓 ID를 사용하여 라우터를 생성하고 해당 방에 대한 정보를 업데이트
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router1
    let peers = []
    if (rooms[roomName]) {
      router1 = rooms[roomName].router
      peers = rooms[roomName].peers || []
    } else {
      router1 = await worker.createRouter({ mediaCodecs, })
    }
    
    console.log(`✅✅✅✅Router ID: ${router1.id}`, peers.length)

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    }

    return router1
  }

  // socket.on('createRoom', async (callback) => {
  //   if (router === undefined) {
  //     // worker.createRouter(options)
  //     // options = { mediaCodecs, appData }
  //     // mediaCodecs -> defined above
  //     // appData -> custom application data - we are not supplying any
  //     // none of the two are required
  //     router = await worker.createRouter({ mediaCodecs, })
  //     console.log(`Router ID: ${router.id}`)
  //   }

  //   getRtpCapabilities(callback)
  // })

  // const getRtpCapabilities = (callback) => {
  //   const rtpCapabilities = router.rtpCapabilities

  //   callback({ rtpCapabilities })
  // }

  // Client emits a request to create server side Transport - 전송 객체와 관련된 정보를 서버에서 클라이언트로 전달
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ consumer }, callback) => { 
    // get Room Name from Peer's properties - 소켓 ID를 이용해서 peers 객체에서 해당 소켓의 방이름을 가져옴
    const roomName = peers[socket.id].roomName

    // get Router (Room) object this peer is in based on RoomName - 방이름을 사용하여 rooms 객체에서 해당 방의 라우터 객체를 가져옴
    const router = rooms[roomName].router


    createWebRtcTransport(router).then(//라우터를 기반으로 webRTC 전송 객체를 생성, PROMISE가 해결되면 THEN블록이 실행됨
      transport => {
        callback({ // 클라이언트의 콜백 함수를 호출하여, 생성된 params(전송객체)를 인자로 전달하여 클라이언트로 전송
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          }
        })

        // add transport to Peer's properties - 전달받은 전송 객체를 peer 객체에 추가 
        addTransport(transport, roomName, consumer)
      },
      error => {
        console.log(error)
      })
  })

  const addTransport = (transport, roomName, consumer) => {

    transports = [ // 전역 변수인 'transports' 배열에 새로운 항목 추가 
      ...transports,
      { socketId: socket.id, transport, roomName, consumer, }
    ]

    peers[socket.id] = { // peers 객체에서 현재 소켓의 id를 키로 하는 항목을 업데이트
      ...peers[socket.id],
      transports: [
        ...peers[socket.id].transports,
        transport.id,
      ]
    }
  }

  const addProducer = (producer, roomName) => { //producer를 peer 객체에 추가하는 함수
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

  const addConsumer = (consumer, roomName) => { //consumer를 peer객체에 추가하는 함수 
    // add the consumer to the consumers list
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ]

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...peers[socket.id].consumers,
        consumer.id,
      ]
    }
  }

  socket.on('getProducers', callback => { // 해당 방에 있는 다른 클라이언트들의 프로듀서 리스트를 반환하는 기능을 구현
    //return all producer transports
    const { roomName } = peers[socket.id]

    let producerList = []
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id]
      }
    })

    // return the producer list back to the client -- 클라이언트에게 다시 콜백
    callback(producerList)
  })


  const getTransport = (socketId) => { //socketid를 매개변수로 받아서 해당 소켓 id와 연결된 producer 전송 객체를 찾는 함수
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    return producerTransport.transport
  }

  // see client's socket.emit('transport-connect', ...) - producer와 consumer을 연결하기 위해 transport를 사용하는 이벤트 
  socket.on('transport-connect', ({ dtlsParameters }) => {
    // console.log('DTLS PARAMS... ', { dtlsParameters })  
    
    getTransport(socket.id).connect({ dtlsParameters })
  })

  const informConsumers = (roomName, socketId, id) => { //새로운 프로듀서가 참여했을 때, consumer에게 새로 알리는 역할(새로운 참가자 조인시 알림)
    console.log(`새로운 producer 참여, id ${id} ${roomName}, ${socketId}`)
    // A new producer just joined
    // let all consumers to consume this producer
    producers.forEach(producerData => { 
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = peers[producerData.socketId].socket
        // use socket to send producer id to producer
        producerSocket.emit('new-producer', { producerId: id })
      }
    })
  }
  // see client's socket.emit('transport-produce', ...) - 클라이언트 요청에 따라 producer를 생성하고 관리
  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    const producer = await getTransport(socket.id).produce({ // 클라이언트의 요청에 따라 transport를 사용하여 producer 생성
      kind,
      rtpParameters,
    })

    // add producer to the producers array
    const { roomName } = peers[socket.id]

    addProducer(producer, roomName) // producer 추가

    informConsumers(roomName, socket.id, producer.id) //다른 consumer들에게 producer 추가 사실 알림

    console.log('Producer 생성 종류 '/*ID: producer.id,*/ ,producer.kind)

    producer.on('transportclose', () => { // producer와 연결된 transport가 닫힐때 발생
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({ // client로 producer id 전송
      id: producer.id,
      producersExist: producers.length>1 ? true : false
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => { //consumer에서 전송한 transport를 서버의 producer와 연결하는 작업 수행
    // console.log(`DTLS PARAMS: ${dtlsParameters}`)
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport
    await consumerTransport.connect({ dtlsParameters })
  })

  // consume이벤트는 클라이언트에서 producer로부터 전달받은 rtp capabilites를 기반으로 consumer를 생성
  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => { 
    try {

      const { roomName } = peers[socket.id]
      const router = rooms[roomName].router
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id == serverConsumerTransportId
      )).transport

      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('❌❌transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('❌❌producer of consumer closed')
          socket.emit('producer-closed', { remoteProducerId })

          consumerTransport.close([])
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id)
          consumer.close()
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id)
        })

        addConsumer(consumer, roomName)

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async ({ serverConsumerId }) => { // 클라이언트에서 서버로 전송되는 이벤트로 미디어 스트림의 수신을 재개하는 역할을 함
    // console.log('consumer resume')
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId)
    await consumer.resume()
  })
})

//router 매개변수를 받아와서 해당 라우터를 기반을 webRtc 전송 객체를 생성하고 반환하는 함수
const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => { //성공적을 전송 객체를 생성하여 resolve를 호출하여 전송 객체를 반환| 실패했을 경우 reject를 반환
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [ //webRTC 전송 객체가 수신할 수 있는 IP 주소 목록을 지정
          {
            ip: '192.168.56.1', // 본인 컴퓨터 ip 주소로 적어야합니다
            // announcedIp: '192.168.56.1',
          }
        ],
        enableUdp: true, //udp 전송 가능한지 여부
        enableTcp: true, //tcp 전송 가능한지 여부
        preferUdp: true, //그중 udp를 선호하는지 여부를 나타냄
      }

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options) //webRtcTransport_options를 인수로 전달받아 webrtc 전송 객체를 생성
      // console.log(`transport id: ${transport.id}`)

      transport.on('dtlsstatechange', dtlsState => { //DTLS 상태 변화를 감지하고 
        if (dtlsState === 'closed') { //dtlsstate 값이 closed인 경우에는 전송 객체를 닫는다.
          transport.close()
        }
      })

      transport.on('close', () => { // 전송 객체가 아예 닫힐 때 호출되는 이벤트
        console.log('transport closed')
      })

      resolve(transport) // 전송 객체 생성이 완료되면 promise의 resolve 함수를 호출하여 생성된 전송 객체를 반환

    } catch (error) { //객체 생성하다가 오류 발생하면 reject 함수를 호출하여 오류를 반환
      reject(error)
    }
  })
}