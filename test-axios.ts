import axios, { AxiosResponse } from 'axios';

async function checkAxios() {
  const response: AxiosResponse<any> = await axios.get('https://api.github.com');
  console.log('Status:', response.status);
  console.log('Data:', response.data);
}

checkAxios();
