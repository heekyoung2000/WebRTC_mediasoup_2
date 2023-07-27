const aws_table_name = "nodeTest";
const aws_local_config = {
    region: "local",
    endpoint: "http://localhost:3000"
};
const aws_remote_config = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: "us-east-1"
};

export { aws_table_name, aws_local_config, aws_remote_config };